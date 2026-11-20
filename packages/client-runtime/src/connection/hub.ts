import { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ConnectionDriver from "./driver.ts";
import {
  type ConnectionAttemptError,
  ConnectionBlockedError,
  ConnectionTarget,
  ConnectionTransientError,
  type PreparedConnection,
} from "./model.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import type { RpcPort } from "../rpc/relay.ts";
import * as RpcSession from "../rpc/session.ts";

const PreparedHttpAuthorization = Schema.Union([
  Schema.TaggedStruct("Bearer", { token: Schema.String }),
  Schema.TaggedStruct("Dpop", { accessToken: Schema.String, expiresAtEpochMs: Schema.Number }),
]);

const PreparedConnectionSchema = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  httpBaseUrl: Schema.String,
  socketUrl: Schema.String,
  httpAuthorization: Schema.NullOr(PreparedHttpAuthorization),
  target: ConnectionTarget,
  descriptor: Schema.optionalKey(ExecutionEnvironmentDescriptor),
});

const ConnectionAttemptErrorSchema = Schema.Union([
  ConnectionTransientError,
  ConnectionBlockedError,
]);

/** Plain values for crossing a window boundary, where class instances lose their prototype. */
export const encodePreparedConnection = Schema.encodeSync(
  Schema.toCodecJson(PreparedConnectionSchema),
);
export const decodePreparedConnection = Schema.decodeUnknownSync(
  Schema.toCodecJson(PreparedConnectionSchema),
);
export const encodeConnectionAttemptError = Schema.encodeSync(
  Schema.toCodecJson(ConnectionAttemptErrorSchema),
);
export const decodeConnectionAttemptError = Schema.decodeUnknownSync(
  Schema.toCodecJson(ConnectionAttemptErrorSchema),
);

export interface HubLease {
  readonly prepared: PreparedConnection;
  readonly port: RpcPort;
}

/** How a secondary window asks the hub window for one environment's connection. */
export class HubLeaseSource extends Context.Service<
  HubLeaseSource,
  {
    /** The lease ends, and the hub stops relaying, when the scope closes. */
    readonly lease: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<HubLease, ConnectionAttemptError, Scope.Scope>;
  }
>()("@t3tools/client-runtime/connection/hub/HubLeaseSource") {}

/**
 * The connection driver of a secondary window: every environment connects
 * through the hub window's existing session instead of a socket of its own.
 */
const makeHubDriver = Effect.gen(function* () {
  const hub = yield* HubLeaseSource;
  const sessions = yield* RpcSession.RpcSessionFactory;
  return ConnectionDriver.ConnectionDriver.of({
    connect: Effect.fn("HubConnectionDriver.connect")(function* (entry, reportProgress) {
      yield* Effect.annotateCurrentSpan({
        "connection.environment.id": entry.target.environmentId,
      });
      yield* reportProgress({ stage: "preparing" });
      const { prepared, port } = yield* hub.lease(entry.target.environmentId);
      yield* reportProgress({ stage: "opening", prepared });
      const session = yield* sessions.connectOverPort(prepared, port);
      yield* reportProgress({ stage: "synchronizing", prepared });
      yield* session.ready;
      return { prepared, session } satisfies ConnectionDriver.EnvironmentConnectionLease;
    }),
    // Route choice belongs to the hub, which owns the socket.
    preflight: Effect.fn("HubConnectionDriver.preflight")(() =>
      Effect.succeed("unchecked" as const),
    ),
    checkHost: Effect.fn("HubConnectionDriver.checkHost")(() =>
      Effect.succeed("answered" as const),
    ),
  });
});

export const layerHubDriver = Layer.effect(ConnectionDriver.ConnectionDriver, makeHubDriver);

type HubSessionState =
  | {
      readonly _tag: "Ready";
      readonly prepared: PreparedConnection;
      readonly session: RpcSession.RpcSession;
      readonly supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"];
    }
  | { readonly _tag: "Blocked"; readonly error: ConnectionAttemptError };

const hubSessionStates = Stream.unwrap(
  Effect.gen(function* () {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    return Stream.merge(
      SubscriptionRef.changes(supervisor.session),
      SubscriptionRef.changes(supervisor.state),
    ).pipe(
      Stream.mapEffect(() =>
        Effect.all([
          SubscriptionRef.get(supervisor.session),
          SubscriptionRef.get(supervisor.prepared),
          SubscriptionRef.get(supervisor.state),
        ]),
      ),
      Stream.map(([session, prepared, state]): Option.Option<HubSessionState> => {
        if (Option.isSome(session) && Option.isSome(prepared)) {
          return Option.some({
            _tag: "Ready",
            prepared: prepared.value,
            session: session.value,
            supervisor,
          });
        }
        if (state.phase === "blocked" && state.lastFailure !== null) {
          return Option.some({ _tag: "Blocked", error: state.lastFailure });
        }
        return Option.none();
      }),
      Stream.filter(Option.isSome),
      Stream.map((state) => state.value),
    );
  }),
);

/**
 * The hub's side of a lease: waits for this window's own session to the
 * environment, then relays `port` through it until the scope closes or the
 * session ends. A blocked environment fails the lease with its own error.
 */
export const serveHubLease = Effect.fn("HubConnection.serveLease")(function* (
  environmentId: EnvironmentId,
  port: RpcPort,
) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const head = yield* registry.followStream(environmentId, hubSessionStates).pipe(Stream.runHead);
  if (Option.isNone(head)) {
    return yield* new ConnectionTransientError({
      reason: "endpoint-unavailable",
      detail: "The main window no longer has this environment.",
    });
  }
  const state = head.value;
  if (state._tag === "Blocked") return yield* state.error;
  const { prepared, session, supervisor } = state;
  if (session.relay === undefined) {
    return yield* new ConnectionTransientError({
      reason: "transport",
      detail: `${prepared.label} cannot be shared with another window.`,
    });
  }
  const relay = yield* session.relay(port);
  // A session that ends or is replaced takes its relays with it, so the window reconnects at once.
  yield* Effect.raceFirst(
    session.closed.pipe(Effect.ignore),
    SubscriptionRef.changes(supervisor.session).pipe(
      Stream.filter((current) => Option.getOrNull(current) !== session),
      Stream.runHead,
    ),
  ).pipe(Effect.andThen(relay.close("The main window's connection ended.")), Effect.forkScoped);
  return prepared;
});
