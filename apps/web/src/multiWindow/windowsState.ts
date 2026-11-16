import type {
  DesktopOpenWindow,
  DesktopWindowContext,
  DesktopWindowProfile,
  DesktopWindowsState,
} from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { desktopWindowsBridge, readDesktopWindowContext } from "./windowContext";

let state: DesktopWindowsState | null = null;
let started = false;
const listeners = new Set<() => void>();

function publish(next: DesktopWindowsState): void {
  state = next;
  for (const listener of listeners) listener();
}

function ensureStarted(): void {
  if (started) return;
  const bridge = desktopWindowsBridge();
  if (bridge === null) return;
  started = true;
  let pushed = false;
  bridge.onState((next) => {
    pushed = true;
    publish(next);
  });
  // A push that lands first is newer than this snapshot.
  void bridge.getState().then(
    (next) => {
      if (!pushed) publish(next);
    },
    (cause: unknown) => {
      console.error("Failed to read desktop windows state.", cause);
    },
  );
}

export function readDesktopWindowsState(): DesktopWindowsState | null {
  ensureStarted();
  return state;
}

export function subscribeDesktopWindowsState(listener: () => void): () => void {
  ensureStarted();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Null outside a desktop shell with multi-window support, and until the first state arrives. */
export function useDesktopWindowsState(): DesktopWindowsState | null {
  return useSyncExternalStore(subscribeDesktopWindowsState, readDesktopWindowsState, () => null);
}

export function selectCurrentWindow(
  windowsState: DesktopWindowsState | null,
  context: DesktopWindowContext | null,
): DesktopOpenWindow | null {
  if (windowsState === null || context === null) return null;
  return windowsState.windows.find((window) => window.windowId === context.windowId) ?? null;
}

/** The window's live profile: saving or deleting it changes the profile after open. */
export function selectCurrentWindowProfile(
  windowsState: DesktopWindowsState | null,
  context: DesktopWindowContext | null,
): DesktopWindowProfile | null {
  if (windowsState === null || context === null) return null;
  const window = selectCurrentWindow(windowsState, context);
  const profileId = window === null ? context.profileId : window.profileId;
  if (profileId === null) return null;
  return windowsState.profiles.find((profile) => profile.id === profileId) ?? null;
}

/**
 * The theme preference id this window uses instead of the shared one, or null to follow it.
 * Before the first state arrives, the preload's open-time theme avoids a flash.
 */
export function resolveWindowThemeOverride(
  windowsState: DesktopWindowsState | null,
  context: DesktopWindowContext | null,
): string | null {
  if (context === null || context.isMain) return null;
  if (windowsState === null) return context.theme;
  return selectCurrentWindowProfile(windowsState, context)?.theme ?? null;
}

export function isMiniMainWindow(
  windowsState: DesktopWindowsState | null,
  context: DesktopWindowContext | null,
): boolean {
  return context?.isMain === true && windowsState?.miniMode === true;
}

export function useIsMiniMainWindow(): boolean {
  return isMiniMainWindow(useDesktopWindowsState(), readDesktopWindowContext());
}
