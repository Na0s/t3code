import type {
  DesktopWindowContext,
  DesktopWindowProfile,
  DesktopWindowsState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { openWindow } from "./ui/mini.test-fixtures";
import {
  isMiniMainWindow,
  resolveWindowThemeOverride,
  selectCurrentWindowProfile,
} from "./windowsState";

const mainProfile: DesktopWindowProfile = {
  id: "main",
  name: "Main",
  projectScopeKeys: [],
  theme: null,
  isDefault: true,
};
const workProfile: DesktopWindowProfile = {
  id: "work",
  name: "Work",
  projectScopeKeys: ["project:a"],
  theme: "dracula",
  isDefault: false,
};

const unsavedWindow = openWindow(2, "Window 2", "", { profileId: null, focused: true });

function context(overrides: Partial<DesktopWindowContext> = {}): DesktopWindowContext {
  return {
    windowId: 2,
    isMain: false,
    profileId: null,
    projectScopeKeys: [],
    theme: null,
    ...overrides,
  };
}

function windowsState(overrides: Partial<DesktopWindowsState> = {}): DesktopWindowsState {
  return {
    profiles: [mainProfile, workProfile],
    windows: [
      openWindow(1, "Main", "", { isMain: true, profileId: "main" }),
      openWindow(2, "Work", "", { profileId: "work", focused: true }),
    ],
    miniMode: false,
    multiWindowEnabled: true,
    ...overrides,
  };
}

describe("selectCurrentWindowProfile", () => {
  it("follows the live window entry, not the profile the window opened with", () => {
    // Opened unsaved, then saved as "work".
    expect(selectCurrentWindowProfile(windowsState(), context({ profileId: null }))).toBe(
      workProfile,
    );
    const deleted = windowsState({ windows: [unsavedWindow] });
    expect(selectCurrentWindowProfile(deleted, context({ profileId: "work" }))).toBeNull();
  });

  it("falls back to the open-time profile until the window appears in state", () => {
    expect(
      selectCurrentWindowProfile(windowsState({ windows: [] }), context({ profileId: "work" })),
    ).toBe(workProfile);
  });
});

describe("resolveWindowThemeOverride", () => {
  it.each([
    ["no desktop context", null, windowsState(), null],
    ["the main window", context({ windowId: 1, isMain: true, theme: "x" }), windowsState(), null],
    ["state not loaded yet", context({ theme: "nord" }), null, "nord"],
    ["a profile with a theme", context(), windowsState(), "dracula"],
    [
      "a profile that follows the main window",
      context(),
      windowsState({ profiles: [mainProfile, { ...workProfile, theme: null }] }),
      null,
    ],
    [
      "an unsaved window",
      context({ theme: "nord" }),
      windowsState({ windows: [unsavedWindow] }),
      null,
    ],
  ] as const)("resolves %s", (_label, windowContext, state, expected) => {
    expect(resolveWindowThemeOverride(state, windowContext)).toBe(expected);
  });
});

describe("isMiniMainWindow", () => {
  it("applies Mini Mode to the main window only", () => {
    const mini = windowsState({ miniMode: true });
    expect(isMiniMainWindow(mini, context({ windowId: 1, isMain: true }))).toBe(true);
    expect(isMiniMainWindow(mini, context())).toBe(false);
    expect(isMiniMainWindow(windowsState(), context({ windowId: 1, isMain: true }))).toBe(false);
    expect(isMiniMainWindow(null, context({ windowId: 1, isMain: true }))).toBe(false);
  });
});
