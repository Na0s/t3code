import { describe, expect, it } from "vite-plus/test";

import { cascadeWindowBounds } from "./DesktopWindowProfiles.ts";

describe("cascadeWindowBounds", () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 };

  it("offsets from the opener and wraps back inside its display", () => {
    const size = { width: 1100, height: 780 };
    expect(
      cascadeWindowBounds({
        anchor: { x: 100, y: 100, width: 1100, height: 780 },
        size,
        displays: [display],
      }),
    ).toEqual({ x: 128, y: 128, width: 1100, height: 780 });
    expect(
      cascadeWindowBounds({
        anchor: { x: 900, y: 290, width: 1100, height: 780 },
        size,
        displays: [display],
      }),
    ).toEqual({ x: 28, y: 28, width: 1100, height: 780 });
    expect(cascadeWindowBounds({ anchor: null, size, displays: [display] })).toEqual(size);
  });
});
