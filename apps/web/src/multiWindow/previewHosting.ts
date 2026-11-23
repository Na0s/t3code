import { useSyncExternalStore } from "react";

import { readDesktopWindowContext } from "./windowContext";
import { readDesktopWindowsState, subscribeDesktopWindowsState } from "./windowsState";

const KEY_PREFIX = "t3code:desktop-window-previews:";

/**
 * Threads whose previews another open window hosts, from each window's published list.
 * Lists from windows that are no longer open are ignored, since a crash leaves them behind.
 */
export function threadsHostedByOtherWindows(
  entries: ReadonlyArray<readonly [key: string, value: string | null]>,
  openWindowIds: ReadonlySet<number>,
  ownWindowId: number,
): ReadonlySet<string> {
  const hosted = new Set<string>();
  for (const [key, value] of entries) {
    if (!key.startsWith(KEY_PREFIX) || value === null) continue;
    const windowId = Number(key.slice(KEY_PREFIX.length));
    if (windowId === ownWindowId || !openWindowIds.has(windowId)) continue;
    try {
      const threadKeys: unknown = JSON.parse(value);
      if (!Array.isArray(threadKeys)) continue;
      for (const threadKey of threadKeys) if (typeof threadKey === "string") hosted.add(threadKey);
    } catch {}
  }
  return hosted;
}

/** A secondary window announces the threads whose previews it shows, so the main window skips them. */
export function publishHostedPreviewThreads(threadKeys: ReadonlyArray<string>): () => void {
  const context = readDesktopWindowContext();
  if (context === null || context.isMain) return () => {};
  const key = `${KEY_PREFIX}${context.windowId}`;
  try {
    if (threadKeys.length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(threadKeys));
  } catch {}
  return () => {
    try {
      window.localStorage.removeItem(key);
    } catch {}
  };
}

const EMPTY: ReadonlySet<string> = new Set();
let cachedSignature = "";
let cachedHosted: ReadonlySet<string> = EMPTY;
// React reads the snapshot every render; storage is scanned only after a change.
let stale = true;

function readHostedElsewhere(): ReadonlySet<string> {
  if (!stale) return cachedHosted;
  stale = false;
  const context = readDesktopWindowContext();
  const state = readDesktopWindowsState();
  if (context === null || !context.isMain || state === null || state.windows.length < 2) {
    cachedSignature = "";
    cachedHosted = EMPTY;
    return EMPTY;
  }
  const entries: Array<readonly [string, string | null]> = [];
  try {
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(KEY_PREFIX)) entries.push([key, window.localStorage.getItem(key)]);
    }
  } catch {
    return EMPTY;
  }
  const hosted = threadsHostedByOtherWindows(
    entries,
    new Set(state.windows.map((open) => open.windowId)),
    context.windowId,
  );
  const signature = [...hosted].toSorted().join("\n");
  if (signature !== cachedSignature) {
    cachedSignature = signature;
    cachedHosted = hosted;
  }
  return cachedHosted;
}

function subscribeHostedElsewhere(listener: () => void): () => void {
  const changed = () => {
    stale = true;
    listener();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(KEY_PREFIX)) changed();
  };
  window.addEventListener("storage", onStorage);
  const unsubscribeWindows = subscribeDesktopWindowsState(changed);
  return () => {
    window.removeEventListener("storage", onStorage);
    unsubscribeWindows();
  };
}

/** In the main window: threads a secondary window shows, whose previews it hosts instead. */
export function useThreadsHostedElsewhere(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeHostedElsewhere, readHostedElsewhere, () => EMPTY);
}
