import { DESKTOP_HUB_LINK_MESSAGE_TYPE, type DesktopHubLinkMessage } from "@t3tools/contracts";
import type { RpcPort } from "@t3tools/client-runtime/rpc";

/** Messages a secondary window sends the hub over its link port. */
export type HubLinkRequest =
  | { readonly type: "lease"; readonly leaseId: number; readonly environmentId: string }
  | { readonly type: "release"; readonly leaseId: number };

/** The hub's answers. A `leased` message transfers the lease's session port. */
export type HubLinkResponse =
  | { readonly type: "leased"; readonly leaseId: number; readonly prepared: unknown }
  | { readonly type: "leaseFailed"; readonly leaseId: number; readonly error: unknown };

export function toRpcPort(port: MessagePort): RpcPort {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => {
      const handle = (event: MessageEvent) => listener(event.data);
      port.addEventListener("message", handle);
      port.start();
      return () => port.removeEventListener("message", handle);
    },
    close: () => port.close(),
  };
}

function isHubLinkMessage(data: unknown): data is DesktopHubLinkMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { readonly type?: unknown }).type === DESKTOP_HUB_LINK_MESSAGE_TYPE &&
    typeof (data as { readonly peerWindowId?: unknown }).peerWindowId === "number"
  );
}

/** The preload hands link ports to the page with `window.postMessage`, as ports cannot cross the bridge. */
export function onHubLinkPort(
  listener: (port: MessagePort, peerWindowId: number) => void,
): () => void {
  const handle = (event: MessageEvent) => {
    const port = event.ports[0];
    if (event.source !== window || port === undefined || !isHubLinkMessage(event.data)) return;
    listener(port, event.data.peerWindowId);
  };
  window.addEventListener("message", handle);
  return () => window.removeEventListener("message", handle);
}
