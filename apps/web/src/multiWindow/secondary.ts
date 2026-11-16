import {
  type ConnectionAttemptError,
  ConnectionTransientError,
  HubConnection,
} from "@t3tools/client-runtime/connection";
import type { RpcPort } from "@t3tools/client-runtime/rpc";
import type { DesktopWindowsBridge, EnvironmentId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { type HubLinkRequest, type HubLinkResponse, onHubLinkPort, toRpcPort } from "./hubLink";
import { desktopWindowsBridge } from "./windowContext";

const hubGone = (detail: string) =>
  new ConnectionTransientError({ reason: "transport", detail, hop: "device" });

const sendToHub = (port: MessagePort, request: HubLinkRequest) => port.postMessage(request);

interface ActiveLease {
  readonly result: Deferred.Deferred<HubConnection.HubLease, ConnectionAttemptError>;
  /** Ends the lease's session as if the relay had closed it. */
  end: (detail: string) => void;
}

interface Link {
  readonly port: MessagePort;
  readonly leases: Map<number, ActiveLease>;
}

const isHubLinkResponse = (data: unknown): data is HubLinkResponse =>
  typeof data === "object" &&
  data !== null &&
  typeof (data as { readonly leaseId?: unknown }).leaseId === "number" &&
  ((data as { readonly type?: unknown }).type === "leased" ||
    (data as { readonly type?: unknown }).type === "leaseFailed");

/** A session port that can also be ended locally when the hub disappears without a word. */
function endableRpcPort(port: MessagePort): {
  readonly port: RpcPort;
  readonly end: (detail: string) => void;
} {
  const base = toRpcPort(port);
  const listeners = new Set<(message: unknown) => void>();
  return {
    port: {
      ...base,
      onMessage: (listener) => {
        listeners.add(listener);
        const stop = base.onMessage(listener);
        return () => {
          listeners.delete(listener);
          stop();
        };
      },
    },
    end: (detail) => {
      for (const listener of listeners) listener({ _tag: "RelayClosed", detail });
    },
  };
}

function makeLeaseSource(bridge: DesktopWindowsBridge) {
  let link: Link | null = null;
  let linkWaiters: Array<(link: Link) => void> = [];
  let linkRequested = false;
  let nextLeaseId = 1;

  const onResponse = (current: Link) => (event: MessageEvent) => {
    const response: unknown = event.data;
    if (!isHubLinkResponse(response)) return;
    const lease = current.leases.get(response.leaseId);
    if (lease === undefined) return;
    if (response.type === "leaseFailed") {
      current.leases.delete(response.leaseId);
      Deferred.doneUnsafe(
        lease.result,
        Effect.fail(HubConnection.decodeConnectionAttemptError(response.error)),
      );
      return;
    }
    const sessionPort = event.ports[0];
    if (sessionPort === undefined) return;
    const endable = endableRpcPort(sessionPort);
    lease.end = endable.end;
    Deferred.doneUnsafe(
      lease.result,
      Effect.succeed({
        prepared: HubConnection.decodePreparedConnection(response.prepared),
        port: endable.port,
      }),
    );
  };

  onHubLinkPort((port) => {
    dropLink("The main window replaced this window's link.");
    const next: Link = { port, leases: new Map() };
    link = next;
    linkRequested = false;
    port.addEventListener("message", onResponse(next));
    port.start();
    const waiters = linkWaiters;
    linkWaiters = [];
    for (const waiter of waiters) waiter(next);
  });

  const dropLink = (detail: string) => {
    const current = link;
    link = null;
    if (current === null) return;
    for (const lease of current.leases.values()) {
      Deferred.doneUnsafe(lease.result, Effect.fail(hubGone(detail)));
      lease.end(detail);
    }
    current.leases.clear();
    current.port.close();
  };

  bridge.onHubReset(() => {
    linkRequested = false;
    dropLink("The main window reloaded.");
    // Sessions waiting on the old link reconnect through a fresh one.
    if (linkWaiters.length > 0) {
      linkRequested = true;
      bridge.requestHubLink();
    }
  });

  const awaitLink = Effect.callback<Link>((resume) => {
    if (link !== null) {
      resume(Effect.succeed(link));
      return;
    }
    const waiter = (ready: Link) => resume(Effect.succeed(ready));
    linkWaiters.push(waiter);
    if (!linkRequested) {
      linkRequested = true;
      bridge.requestHubLink();
    }
    return Effect.sync(() => {
      linkWaiters = linkWaiters.filter((candidate) => candidate !== waiter);
    });
  });

  return HubConnection.HubLeaseSource.of({
    lease: Effect.fn("DesktopHubLeaseSource.lease")(function* (environmentId: EnvironmentId) {
      const current = yield* awaitLink;
      const leaseId = nextLeaseId++;
      const lease: ActiveLease = {
        result: yield* Deferred.make<HubConnection.HubLease, ConnectionAttemptError>(),
        end: () => undefined,
      };
      current.leases.set(leaseId, lease);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          current.leases.delete(leaseId);
          if (link === current) {
            sendToHub(current.port, { type: "release", leaseId });
          }
        }),
      );
      sendToHub(current.port, { type: "lease", leaseId, environmentId });
      return yield* Deferred.await(lease.result);
    }),
  });
}

/** Secondary windows connect every environment through the main window's sessions. */
export const layerHubLeaseSource = Layer.effect(
  HubConnection.HubLeaseSource,
  Effect.suspend(() => {
    const bridge = desktopWindowsBridge();
    return bridge === null
      ? Effect.die(new Error("Secondary windows need the desktop windows bridge."))
      : Effect.succeed(makeLeaseSource(bridge));
  }),
);
