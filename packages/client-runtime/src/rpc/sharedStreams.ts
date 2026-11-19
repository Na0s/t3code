import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcClientError from "effect/rpc/RpcClientError";
import type { FromClientEncoded, FromServerEncoded, RequestEncoded } from "effect/rpc/RpcMessage";

type EncodedItem = { readonly [key: string]: unknown };

/**
 * How a subscription is reopened when another subscriber joins it. Nothing is
 * retained: the server replays from the earliest subscriber's cursor, or starts
 * over from current state, and each subscriber skips what it already has.
 */
type ShareStrategy =
  | {
      readonly _tag: "sequenced";
      /** Payload fields that position one subscriber; they never split a shared stream. */
      readonly cursorFields: ReadonlyArray<string>;
      /** The sequence of a snapshot that replaces all state; null for anything else. */
      readonly authoritativeSnapshot: (item: EncodedItem) => number | null;
      readonly eventSequence: (item: EncodedItem) => number | null;
    }
  /** A fresh subscription starts with the whole current state. */
  | { readonly _tag: "restartable" };

const numberField = (value: unknown): number | null => (typeof value === "number" ? value : null);
const SHELL_EVENT_KINDS = new Set([
  "project.updated",
  "project.removed",
  "thread.updated",
  "thread.removed",
]);

const STRATEGIES: ReadonlyMap<string, ShareStrategy> = new Map<string, ShareStrategy>([
  [
    ORCHESTRATION_V2_WS_METHODS.subscribeShell,
    {
      _tag: "sequenced",
      cursorFields: [
        "afterSequence",
        "requestCompletionMarker",
        "httpSnapshotFallback",
        "knownProjectIdentities",
      ],
      // Snapshots with resolved identity roots only enrich projects (see the ws.ts shell resume).
      authoritativeSnapshot: (item) =>
        item.kind === "snapshot" && item.resolvedRepositoryIdentityRoots === undefined
          ? numberField((item.snapshot as EncodedItem | undefined)?.snapshotSequence)
          : null,
      eventSequence: (item) =>
        SHELL_EVENT_KINDS.has(String(item.kind)) ? numberField(item.sequence) : null,
    },
  ],
  [
    ORCHESTRATION_V2_WS_METHODS.subscribeThread,
    {
      _tag: "sequenced",
      cursorFields: ["afterSequence", "requestCompletionMarker"],
      authoritativeSnapshot: (item) =>
        item.kind === "snapshot" ? numberField(item.snapshotSequence) : null,
      eventSequence: (item) => (item.kind === "event" ? numberField(item.sequence) : null),
    },
  ],
  ...[
    WS_METHODS.subscribeVcsStatus,
    WS_METHODS.subscribeAuthAccess,
    WS_METHODS.subscribeTerminalMetadata,
    ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput,
    WS_METHODS.providerAuthSubscribe,
    WS_METHODS.providerInstallSubscribe,
    WS_METHODS.scheduledTasksSubscribe,
    WS_METHODS.subscribeDiscoveredLocalServers,
    WS_METHODS.subscribeDeviceState,
    WS_METHODS.subscribeResourceTelemetry,
    WS_METHODS.subscribeVcsBranch,
    WS_METHODS.subscribeProjectClones,
    WS_METHODS.subscribeWorktreeSetup,
    WS_METHODS.pullRequestsSubscribeRefreshes,
    WS_METHODS.pullRequestsSubscribeLinkedThreadRefreshes,
    ORCHESTRATION_V2_WS_METHODS.subscribePromptSuggestion,
  ].map((tag): [string, ShareStrategy] => [tag, { _tag: "restartable" }]),
]);

/** A subscriber that leaves a chunk unacknowledged this long resubscribes instead of stalling others. */
export const SLOW_SUBSCRIBER_TIMEOUT = Duration.seconds(10);
/** How long a cursor ahead of the stream may wait for in-flight events before everyone resyncs. */
export const AHEAD_CURSOR_GRACE = Duration.seconds(5);

export function canonicalJson(value: unknown, omit: ReadonlyArray<string> = []): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null";
  const entries = Object.entries(value)
    .filter(([key, entry]) => entry !== undefined && !omit.includes(key))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

type RequestId = string | number;

interface PendingAck {
  readonly waiting: Set<Consumer>;
  timer: Fiber.Fiber<void> | null;
}

interface Consumer {
  readonly clientId: number;
  readonly requestId: RequestId;
  readonly wantsMarker: boolean;
  markerSent: boolean;
  /** Last sequence this subscriber has; null while it waits for a snapshot. */
  position: number | null;
  /** Chunks delivered and not yet acknowledged, oldest first; null for a replaced upstream's. */
  readonly unacked: Array<PendingAck | null>;
  aheadTimer: Fiber.Fiber<void> | null;
}

interface Group {
  readonly key: string;
  readonly strategy: ShareStrategy;
  readonly template: RequestEncoded;
  readonly consumers: Map<RequestId, Consumer>;
  upstreamId: string;
  /** One subscriber whose own request is the upstream: chunks and acks pass straight through. */
  passThrough: boolean;
  head: number | null;
  /** The current upstream has sent its completion marker. */
  live: boolean;
  readonly pendingAcks: Array<PendingAck>;
}

let nextInstance = 0;

/**
 * One server subscription per stream and arguments for all clients of a desktop hub
 * session. A lone subscriber passes through; a joiner reopens the upstream from the
 * earliest cursor, so nothing is retained. Acks wait for the slowest subscriber.
 */
export const makeSharedStreamProtocol = (
  inner: RpcClient.Protocol["Service"],
): Effect.Effect<RpcClient.Protocol["Service"], never, Scope.Scope> =>
  RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse, clientIds) {
      const runFork = Effect.runForkWith(yield* Effect.context<never>());
      const instance = nextInstance++;
      // Every client shares one inner client; request ids are unique in this realm.
      const innerClientId = 2_000_000_000 + instance;
      let nextUpstream = 0;
      const routes = new Map<RequestId, number>();
      const groups = new Map<string, Group>();
      const groupsByUpstream = new Map<string, Group>();
      const consumerGroups = new Map<RequestId, Group>();
      const outboxes = new Map<number, Array<FromServerEncoded>>();
      let failure: RpcClientError.RpcClientError | undefined;

      // Per client and in order, so a chunk never overtakes an earlier one.
      const deliver = (clientId: number, message: FromServerEncoded) => {
        const existing = outboxes.get(clientId);
        if (existing !== undefined) {
          existing.push(message);
          return;
        }
        const queue = [message];
        outboxes.set(clientId, queue);
        runFork(
          Effect.gen(function* () {
            while (queue.length > 0) yield* writeResponse(clientId, queue.shift()!);
          }).pipe(Effect.ensuring(Effect.sync(() => outboxes.delete(clientId)))),
        );
      };
      const sendInner = (message: FromClientEncoded) =>
        runFork(inner.send(innerClientId, message).pipe(Effect.ignore));
      const newUpstreamId = () => `shared:${instance}:${nextUpstream++}`;
      const cancelTimer = (fiber: Fiber.Fiber<void> | null) => {
        if (fiber !== null) runFork(Fiber.interrupt(fiber));
      };

      const ackUpstream = (group: Group) => {
        while (group.pendingAcks.length > 0 && group.pendingAcks[0]!.waiting.size === 0) {
          cancelTimer(group.pendingAcks.shift()!.timer);
          sendInner({ _tag: "Ack", requestId: group.upstreamId });
        }
      };

      const forgetConsumer = (group: Group, consumer: Consumer) => {
        group.consumers.delete(consumer.requestId);
        consumerGroups.delete(consumer.requestId);
        cancelTimer(consumer.aheadTimer);
        for (const pending of consumer.unacked) pending?.waiting.delete(consumer);
        consumer.unacked.length = 0;
      };

      const closeGroup = (group: Group) => {
        groups.delete(group.key);
        groupsByUpstream.delete(group.upstreamId);
        for (const consumer of group.consumers.values()) forgetConsumer(group, consumer);
        for (const pending of group.pendingAcks) cancelTimer(pending.timer);
        group.pendingAcks.length = 0;
      };

      const leave = (group: Group, consumer: Consumer) => {
        forgetConsumer(group, consumer);
        if (group.consumers.size === 0) {
          sendInner({ _tag: "Interrupt", requestId: group.upstreamId });
          closeGroup(group);
          return;
        }
        ackUpstream(group);
      };

      /** Fails only this subscriber's request; it resubscribes from its own cursor. */
      const resync = (group: Group, consumer: Consumer, detail: string) => {
        leave(group, consumer);
        deliver(consumer.clientId, {
          _tag: "ClientProtocolError",
          error: new RpcClientError.RpcClientError({
            reason: new RpcClientError.RpcClientDefect({ message: detail, cause: undefined }),
          }),
          requestIds: [consumer.requestId],
        });
      };

      /** Replaces the upstream with one every current subscriber can resume from. */
      const reopen = (group: Group, fromScratch: boolean) => {
        sendInner({ _tag: "Interrupt", requestId: group.upstreamId });
        groupsByUpstream.delete(group.upstreamId);
        for (const pending of group.pendingAcks) cancelTimer(pending.timer);
        group.pendingAcks.length = 0;
        for (const consumer of group.consumers.values()) consumer.unacked.fill(null);
        group.passThrough = false;
        group.live = false;
        group.upstreamId = newUpstreamId();
        groupsByUpstream.set(group.upstreamId, group);
        const strategy = group.strategy;
        if (strategy._tag === "restartable") {
          sendInner({ ...group.template, id: group.upstreamId });
          return;
        }
        const positions = Array.from(group.consumers.values(), (consumer) => consumer.position);
        const cursor =
          fromScratch || positions.includes(null)
            ? null
            : Math.min(...positions.filter((position) => position !== null));
        group.head = cursor;
        if (fromScratch) {
          for (const consumer of group.consumers.values()) {
            consumer.position = null;
            cancelTimer(consumer.aheadTimer);
            consumer.aheadTimer = null;
          }
        }
        const base = Object.fromEntries(
          Object.entries(group.template.payload as EncodedItem).filter(
            ([key]) => !strategy.cursorFields.includes(key),
          ),
        );
        sendInner({
          ...group.template,
          id: group.upstreamId,
          // Without `httpSnapshotFallback`: a gap answers with a snapshot every subscriber can use.
          payload: {
            ...base,
            ...(cursor === null ? {} : { afterSequence: cursor }),
            requestCompletionMarker: true,
          },
        });
      };

      const watchAhead = (group: Group, consumer: Consumer) => {
        cancelTimer(consumer.aheadTimer);
        consumer.aheadTimer = runFork(
          Effect.sleep(AHEAD_CURSOR_GRACE).pipe(
            Effect.andThen(
              Effect.sync(() => {
                consumer.aheadTimer = null;
                if (!group.consumers.has(consumer.requestId) || consumer.position === null) return;
                // The server never reached this cursor, so it lost history: everyone starts over.
                if ((group.head ?? -1) < consumer.position) reopen(group, true);
              }),
            ),
          ),
        );
      };

      const subscribe = (clientId: number, request: RequestEncoded, strategy: ShareStrategy) => {
        const payload = request.payload as EncodedItem | null;
        const key = `${request.tag}\u0000${canonicalJson(
          request.payload,
          strategy._tag === "sequenced" ? strategy.cursorFields : [],
        )}`;
        const consumer: Consumer = {
          clientId,
          requestId: request.id,
          wantsMarker: payload?.requestCompletionMarker === true,
          markerSent: false,
          position: strategy._tag === "sequenced" ? numberField(payload?.afterSequence) : null,
          unacked: [],
          aheadTimer: null,
        };
        const existing = groups.get(key);
        if (existing === undefined) {
          const group: Group = {
            key,
            strategy,
            template: request,
            consumers: new Map([[consumer.requestId, consumer]]),
            upstreamId: newUpstreamId(),
            passThrough: true,
            head: consumer.position,
            live: false,
            pendingAcks: [],
          };
          groups.set(key, group);
          groupsByUpstream.set(group.upstreamId, group);
          consumerGroups.set(consumer.requestId, group);
          sendInner({ ...request, id: group.upstreamId });
          return;
        }
        const head = existing.head;
        existing.consumers.set(consumer.requestId, consumer);
        consumerGroups.set(consumer.requestId, existing);
        reopen(existing, false);
        if (consumer.position !== null && head !== null && head < consumer.position) {
          watchAhead(existing, consumer);
        }
      };

      const deliverChunks = (group: Group, perConsumer: Map<Consumer, Array<unknown>>) => {
        const pending: PendingAck = { waiting: new Set(), timer: null };
        for (const [consumer, values] of perConsumer) {
          if (values.length === 0) continue;
          pending.waiting.add(consumer);
          consumer.unacked.push(pending);
          deliver(consumer.clientId, {
            _tag: "Chunk",
            requestId: consumer.requestId,
            values: values as never,
          });
        }
        group.pendingAcks.push(pending);
        if (pending.waiting.size > 0) {
          pending.timer = runFork(
            Effect.sleep(SLOW_SUBSCRIBER_TIMEOUT).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  pending.timer = null;
                  for (const consumer of pending.waiting) {
                    // Alone, a slow subscriber holds back only itself.
                    if (group.consumers.size < 2) break;
                    resync(group, consumer, "This subscriber fell behind the shared stream.");
                  }
                }),
              ),
            ),
          );
        }
        ackUpstream(group);
      };

      const onSharedItems = (group: Group, items: ReadonlyArray<EncodedItem>) => {
        const perConsumer = new Map<Consumer, Array<unknown>>(
          Array.from(group.consumers.values(), (consumer) => [consumer, []]),
        );
        const strategy = group.strategy;
        if (strategy._tag === "restartable") {
          for (const values of perConsumer.values()) values.push(...items);
          deliverChunks(group, perConsumer);
          return;
        }
        // A subscriber is caught up once the stream is live and has reached its cursor.
        const markCaughtUp = (consumer: Consumer, values: Array<unknown>) => {
          if (!group.live || consumer.position === null) return;
          if (consumer.aheadTimer !== null) {
            if ((group.head ?? -1) < consumer.position) return;
            cancelTimer(consumer.aheadTimer);
            consumer.aheadTimer = null;
          }
          if (consumer.wantsMarker && !consumer.markerSent) {
            consumer.markerSent = true;
            values.push({ kind: "synchronized" });
          }
        };
        for (const item of items) {
          if (item.kind === "synchronized") {
            group.live = true;
            for (const [consumer, values] of perConsumer) markCaughtUp(consumer, values);
            continue;
          }
          const snapshotSequence = strategy.authoritativeSnapshot(item);
          if (snapshotSequence !== null) {
            group.head = snapshotSequence;
            for (const [consumer, values] of perConsumer) {
              values.push(item);
              consumer.position = snapshotSequence;
            }
            continue;
          }
          const sequence = strategy.eventSequence(item);
          if (sequence === null) {
            // Project enrichment applies to everyone holding a shell; it moves no cursor.
            for (const [consumer, values] of perConsumer) {
              if (consumer.position !== null) values.push(item);
            }
            continue;
          }
          if (group.head === null || sequence > group.head) group.head = sequence;
          for (const [consumer, values] of perConsumer) {
            if (consumer.position !== null && sequence > consumer.position) {
              values.push(item);
              consumer.position = sequence;
            }
            markCaughtUp(consumer, values);
          }
        }
        deliverChunks(group, perConsumer);
      };

      /** The single subscriber's own stream, forwarded as is; only its position is tracked. */
      const onPassThroughItems = (
        group: Group,
        response: Extract<FromServerEncoded, { _tag: "Chunk" }>,
      ) => {
        const consumer = group.consumers.values().next().value;
        if (consumer === undefined) return;
        const strategy = group.strategy;
        if (strategy._tag === "sequenced") {
          for (const item of response.values as ReadonlyArray<EncodedItem>) {
            if (item.kind === "synchronized") {
              if (consumer.wantsMarker) consumer.markerSent = true;
              continue;
            }
            const sequence = strategy.authoritativeSnapshot(item) ?? strategy.eventSequence(item);
            if (sequence !== null) {
              group.head = sequence;
              consumer.position = sequence;
            }
          }
        }
        deliver(consumer.clientId, { ...response, requestId: consumer.requestId });
      };

      yield* inner
        .run(innerClientId, (response) =>
          Effect.sync(() => {
            const requestId = "requestId" in response ? response.requestId : undefined;
            const group =
              typeof requestId === "string" ? groupsByUpstream.get(requestId) : undefined;
            switch (response._tag) {
              case "Chunk": {
                if (group === undefined) {
                  const clientId = routes.get(response.requestId);
                  if (clientId !== undefined) deliver(clientId, response);
                } else if (group.passThrough) {
                  onPassThroughItems(group, response);
                } else {
                  onSharedItems(group, response.values as ReadonlyArray<EncodedItem>);
                }
                return;
              }
              case "Exit": {
                if (group !== undefined) {
                  for (const consumer of group.consumers.values()) {
                    deliver(consumer.clientId, { ...response, requestId: consumer.requestId });
                  }
                  closeGroup(group);
                  return;
                }
                const clientId = routes.get(response.requestId);
                routes.delete(response.requestId);
                if (clientId !== undefined) deliver(clientId, response);
                return;
              }
              case "ClientProtocolError":
              case "Defect": {
                if (response._tag === "ClientProtocolError") failure = response.error;
                routes.clear();
                for (const open of groups.values()) closeGroup(open);
                for (const clientId of clientIds) deliver(clientId, response);
                return;
              }
              case "Pong":
                return;
              default:
                for (const clientId of clientIds) deliver(clientId, response);
            }
          }),
        )
        .pipe(Effect.forkScoped);

      return {
        send: (clientId, request, transferables) => {
          if (failure !== undefined) return Effect.fail(failure);
          if (request._tag === "Request") {
            const strategy = STRATEGIES.get(request.tag);
            if (strategy !== undefined) {
              return Effect.sync(() => subscribe(clientId, request, strategy));
            }
            routes.set(request.id, clientId);
            return inner
              .send(innerClientId, request, transferables)
              .pipe(Effect.onError(() => Effect.sync(() => routes.delete(request.id))));
          }
          if (request._tag === "Ack" || request._tag === "Interrupt") {
            const group = consumerGroups.get(request.requestId);
            const consumer = group?.consumers.get(request.requestId);
            if (group !== undefined && consumer !== undefined) {
              return Effect.sync(() => {
                if (request._tag === "Interrupt") {
                  leave(group, consumer);
                } else if (group.passThrough) {
                  sendInner({ _tag: "Ack", requestId: group.upstreamId });
                } else {
                  consumer.unacked.shift()?.waiting.delete(consumer);
                  ackUpstream(group);
                }
              });
            }
            if (request._tag === "Interrupt") routes.delete(request.requestId);
          }
          return inner.send(innerClientId, request, transferables);
        },
        supportsAck: inner.supportsAck,
        supportsTransferables: inner.supportsTransferables,
        codecFor: inner.codecFor,
      };
    }),
  );
