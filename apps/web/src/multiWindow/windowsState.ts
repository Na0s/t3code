import type { DesktopWindowsState } from "@t3tools/contracts";

import { desktopWindowsBridge } from "./windowContext";

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
