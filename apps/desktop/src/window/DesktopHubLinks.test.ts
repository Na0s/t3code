import { describe, expect, it } from "vite-plus/test";

import { HubLinkBroker, type HubLinkPeer } from "./DesktopHubLinks.ts";

const setup = () => {
  let channels = 0;
  const deliveries: Array<{ to: number; port: string; peerWindowId: number }> = [];
  const broker = new HubLinkBroker(() => {
    channels += 1;
    return { port1: `hub-end-${channels}`, port2: `window-end-${channels}` };
  });
  const peer = (windowId: number): HubLinkPeer<string> => ({
    windowId,
    deliver: (port, peerWindowId) => deliveries.push({ to: windowId, port, peerWindowId }),
  });
  return { broker, deliveries, peer };
};

describe("HubLinkBroker", () => {
  it("holds requests until the hub registers, once per window", () => {
    const { broker, deliveries, peer } = setup();
    broker.request(peer(2));
    broker.request(peer(2));
    broker.request(peer(3));
    expect(deliveries).toEqual([]);

    broker.registerHub(peer(1));
    expect(deliveries).toEqual([
      { to: 1, port: "hub-end-1", peerWindowId: 2 },
      { to: 2, port: "window-end-1", peerWindowId: 1 },
      { to: 1, port: "hub-end-2", peerWindowId: 3 },
      { to: 3, port: "window-end-2", peerWindowId: 1 },
    ]);
  });

  it("links at once while the hub is ready and makes windows relink after it resets", () => {
    const { broker, deliveries, peer } = setup();
    broker.registerHub(peer(1));
    broker.request(peer(2));
    expect(deliveries).toHaveLength(2);

    expect(broker.resetHub()).toBe(true);
    expect(broker.resetHub()).toBe(false);
    expect(broker.peerGone(2)).toBe(false);
    broker.request(peer(2));
    expect(deliveries).toHaveLength(2);

    broker.registerHub(peer(1));
    expect(deliveries.slice(2)).toEqual([
      { to: 1, port: "hub-end-2", peerWindowId: 2 },
      { to: 2, port: "window-end-2", peerWindowId: 1 },
    ]);
  });

  it("tells the hub about a gone window only when it held links to it", () => {
    const { broker, deliveries, peer } = setup();
    broker.request(peer(4));
    expect(broker.peerGone(4)).toBe(false);
    broker.registerHub(peer(1));
    expect(deliveries).toEqual([]);

    broker.request(peer(2));
    expect(broker.peerGone(2)).toBe(true);
    expect(broker.peerGone(2)).toBe(false);
  });
});
