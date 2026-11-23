import type * as Electron from "electron";

const holds = new WeakMap<Electron.WebContents, Set<string>>();

/**
 * Preview frame capture and the hub's secondary windows can each need a renderer unthrottled;
 * it throttles again only once every holder releases.
 */
export function setUnthrottledHold(
  window: Pick<Electron.BrowserWindow, "isDestroyed" | "webContents">,
  reason: string,
  held: boolean,
): void {
  if (window.isDestroyed()) return;
  const contents = window.webContents;
  const reasons = holds.get(contents) ?? new Set<string>();
  if (held) reasons.add(reason);
  else reasons.delete(reason);
  holds.set(contents, reasons);
  contents.setBackgroundThrottling(reasons.size === 0);
}
