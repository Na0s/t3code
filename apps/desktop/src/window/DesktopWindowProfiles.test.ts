import { describe, expect, it } from "vite-plus/test";

import {
  cascadeWindowBounds,
  composeWindowTitle,
  nextUnsavedWindowName,
  resolveWindowCloseAction,
  type DesktopWindowCloseInput,
} from "./DesktopWindowProfiles.ts";

const unsavedSecondary: DesktopWindowCloseInput = {
  isMain: false,
  quitting: false,
  saved: false,
  secondaryWindowCount: 1,
  closeApproved: false,
  rendererCanPrompt: true,
  promptPending: false,
};

describe("resolveWindowCloseAction", () => {
  it.each([
    ["asks before closing an unsaved window", {}, "prompt"],
    ["waits for the answer to an open prompt", { promptPending: true }, "keep-open"],
    ["closes a saved window without asking", { saved: true }, "close"],
    ["closes without asking while the app quits", { quitting: true }, "close"],
    [
      "closes once save or discard approved it",
      { closeApproved: true, promptPending: true },
      "close",
    ],
    ["closes when the renderer cannot answer", { rendererCanPrompt: false }, "close"],
    ["hides the main window while it serves others", { isMain: true }, "hide"],
    ["closes the main window when it is alone", { isMain: true, secondaryWindowCount: 0 }, "close"],
    ["closes the main window on quit", { isMain: true, quitting: true }, "close"],
  ] as const)("%s", (_name, overrides, expected) => {
    expect(resolveWindowCloseAction({ ...unsavedSecondary, ...overrides })).toBe(expected);
  });

  it("never prompts for the main window, a saved window, or during quit", () => {
    const flags = [false, true];
    for (const isMain of flags)
      for (const quitting of flags)
        for (const saved of flags)
          for (const closeApproved of flags)
            for (const rendererCanPrompt of flags)
              for (const promptPending of flags) {
                const action = resolveWindowCloseAction({
                  isMain,
                  quitting,
                  saved,
                  secondaryWindowCount: 1,
                  closeApproved,
                  rendererCanPrompt,
                  promptPending,
                });
                if (isMain || quitting || saved || closeApproved || !rendererCanPrompt) {
                  expect(action === "prompt" || action === "keep-open").toBe(false);
                }
                if (quitting) expect(action).toBe("close");
              }
  });
});

describe("nextUnsavedWindowName", () => {
  it("takes the lowest free number after the main window", () => {
    expect(nextUnsavedWindowName([])).toBe("Window 2");
    expect(nextUnsavedWindowName(["Window 2", "Window 4"])).toBe("Window 3");
  });
});

describe("composeWindowTitle", () => {
  const title = (overrides: Partial<Parameters<typeof composeWindowTitle>[0]>) =>
    composeWindowTitle({
      rendererTitle: "Fix login",
      fallbackTitle: "T3 Code",
      isMain: true,
      windowName: "Main",
      secondaryWindowCount: 0,
      ...overrides,
    });

  it("names the main window only while other windows are open", () => {
    expect(title({})).toBe("Fix login");
    expect(title({ rendererTitle: " " })).toBe("T3 Code");
    expect(title({ secondaryWindowCount: 1 })).toBe("Fix login - Main");
  });

  it("always names a secondary window", () => {
    expect(title({ isMain: false, windowName: "Window 2" })).toBe("Fix login - Window 2");
  });
});

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
