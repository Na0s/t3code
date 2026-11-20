export interface HubLinkPeer<Port> {
  readonly windowId: number;
  readonly deliver: (port: Port, peerWindowId: number) => void;
}

/**
 * Pairs secondary windows with the main window's renderer, which owns every environment
 * connection. Requests made before the hub registers wait for it.
 */
export class HubLinkBroker<Port> {
  private hub: HubLinkPeer<Port> | null = null;
  private readonly pending = new Map<number, HubLinkPeer<Port>>();
  private readonly linked = new Set<number>();
  private readonly createChannel: () => { port1: Port; port2: Port };

  constructor(createChannel: () => { port1: Port; port2: Port }) {
    this.createChannel = createChannel;
  }

  registerHub(hub: HubLinkPeer<Port>): void {
    this.hub = hub;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const peer of waiting) this.link(hub, peer);
  }

  /** Returns whether the hub had been serving; its secondary windows must then relink. */
  resetHub(): boolean {
    if (this.hub === null) return false;
    this.hub = null;
    this.linked.clear();
    return true;
  }

  request(peer: HubLinkPeer<Port>): void {
    if (this.hub === null) {
      this.pending.set(peer.windowId, peer);
      return;
    }
    this.link(this.hub, peer);
  }

  /** Returns whether the hub held links to the peer and must drop them. */
  peerGone(windowId: number): boolean {
    this.pending.delete(windowId);
    return this.linked.delete(windowId) && this.hub !== null;
  }

  private link(hub: HubLinkPeer<Port>, peer: HubLinkPeer<Port>): void {
    const { port1, port2 } = this.createChannel();
    hub.deliver(port1, peer.windowId);
    peer.deliver(port2, hub.windowId);
    this.linked.add(peer.windowId);
  }
}
