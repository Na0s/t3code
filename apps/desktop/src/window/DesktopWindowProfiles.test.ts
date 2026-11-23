import { describe, expect, it } from "vite-plus/test";

import { cascadeWindowBounds, resizeWithinDisplay } from "./DesktopWindowProfiles.ts";

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

describe("resizeWithinDisplay", () => {
  const left = { x: 0, y: 25, width: 1920, height: 1055 };
  const right = { x: 1920, y: 0, width: 1280, height: 800 };

  it("keeps the origin when the new size fits, and pulls the window back onto its display", () => {
    const medium = { width: 900, height: 760 };
    expect(
      resizeWithinDisplay({
        bounds: { x: 200, y: 100, width: 380, height: 720 },
        size: medium,
        displays: [left, right],
      }),
    ).toEqual({ x: 200, y: 100, ...medium });
    // A narrow window at the right edge of the second display grows to the left.
    expect(
      resizeWithinDisplay({
        bounds: { x: 2800, y: 40, width: 380, height: 720 },
        size: medium,
        displays: [left, right],
      }),
    ).toEqual({ x: 2300, y: 40, ...medium });
    // Larger than the display: as large as it allows.
    expect(
      resizeWithinDisplay({
        bounds: { x: 2000, y: 0, width: 380, height: 720 },
        size: { width: 900, height: 1000 },
        displays: [left, right],
      }),
    ).toEqual({ x: 2000, y: 0, width: 900, height: 800 });
  });
});
