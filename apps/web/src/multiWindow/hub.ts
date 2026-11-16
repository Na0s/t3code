import { EnvironmentRegistry, HubConnection } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { type HubLinkRequest, type HubLinkResponse, onHubLinkPort, toRpcPort } from "./hubLink";
import { desktopWindowsBridge, readDesktopWindowContext } from "./windowContext";

const isHubLinkRequest = (data: unknown): data is HubLinkRequest =>
  typeof data === "object" &&
  data !== null &&
  typeof (data as { readonly leaseId?: unknown }).leaseId === "number" &&
  ((data as { readonly type?: unknown }).type === "release" ||
    ((data as { readonly type?: unknown }).type === "lease" &&
      typeof (data as { readonly environmentId?: unknown }).environmentId === "string"));

/**
 * Serves secondary windows' environment connections from this window's own
 * sessions. Each link is one secondary window; each lease relays one
 * environment's RPC traffic over a dedicated port until that window releases it.
 */
const hubAtom = connectionAtomRuntime
  .atom(
    Effect.gen(function* () {
      const bridge = desktopWindowsBridge();
      if (bridge === null) return;
      const hubScope = yield* Effect.scope;
      const runFork = Effect.runForkWith(
        yield* Effect.context<EnvironmentRegistry.EnvironmentRegistry>(),
      );
      const links = new Map<number, Scope.Closeable>();

      const serveLease = Effect.fn("DesktopWindowHub.serveLease")(function* (
        link: MessagePort,
        linkScope: Scope.Scope,
        leases: Map<number, Scope.Closeable>,
        request: Extract<HubLinkRequest, { type: "lease" }>,
      ) {
        const leaseScope = yield* Scope.fork(linkScope);
        leases.set(request.leaseId, leaseScope);
        const channel = new MessageChannel();
        const respond = (response: HubLinkResponse, transfer: Transferable[] = []) =>
          Effect.sync(() => link.postMessage(response, transfer));
        yield* HubConnection.serveHubLease(
          EnvironmentId.make(request.environmentId),
          toRpcPort(channel.port1),
        ).pipe(
          Scope.provide(leaseScope),
          Effect.matchEffect({
            onSuccess: (prepared) =>
              respond(
                {
                  type: "leased",
                  leaseId: request.leaseId,
                  prepared: HubConnection.encodePreparedConnection(prepared),
                },
                [channel.port2],
              ),
            onFailure: (error) =>
              respond({
                type: "leaseFailed",
                leaseId: request.leaseId,
                error: HubConnection.encodeConnectionAttemptError(error),
              }).pipe(Effect.andThen(Scope.close(leaseScope, Exit.void))),
          }),
          Effect.forkIn(leaseScope),
        );
      });

      const openLink = (port: MessagePort, peerWindowId: number) => {
        const previous = links.get(peerWindowId);
        if (previous !== undefined) runFork(Scope.close(previous, Exit.void));
        const linkScope = Scope.forkUnsafe(hubScope);
        links.set(peerWindowId, linkScope);
        const leases = new Map<number, Scope.Closeable>();
        const handle = (event: MessageEvent) => {
          const request: unknown = event.data;
          if (!isHubLinkRequest(request)) return;
          if (request.type === "release") {
            const lease = leases.get(request.leaseId);
            leases.delete(request.leaseId);
            if (lease !== undefined) runFork(Scope.close(lease, Exit.void));
            return;
          }
          runFork(serveLease(port, linkScope, leases, request));
        };
        port.addEventListener("message", handle);
        port.start();
        runFork(
          Scope.addFinalizer(
            linkScope,
            Effect.sync(() => {
              port.removeEventListener("message", handle);
              port.close();
              if (links.get(peerWindowId) === linkScope) links.delete(peerWindowId);
            }),
          ),
        );
      };

      const closeLink = (peerWindowId: number) => {
        const link = links.get(peerWindowId);
        if (link !== undefined) runFork(Scope.close(link, Exit.void));
      };

      const stopListening = onHubLinkPort(openLink);
      const stopPeerGone = bridge.onHubPeerGone(closeLink);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          stopListening();
          stopPeerGone();
        }),
      );
      bridge.registerHub();
      return yield* Effect.never;
    }),
  )
  .pipe(Atom.keepAlive, Atom.withLabel("desktop-window-hub"));

/** The main window serves every other window's connections for the life of the page. */
export function startDesktopWindowHub(): void {
  if (readDesktopWindowContext()?.isMain !== true) return;
  appAtomRegistry.mount(hubAtom);
}
