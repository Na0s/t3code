import type { DesktopWindowContext, DesktopWindowsBridge } from "@t3tools/contracts";

export function desktopWindowsBridge(): DesktopWindowsBridge | null {
  if (typeof window === "undefined") return null;
  return window.desktopBridge?.windows ?? null;
}

let cachedContext: DesktopWindowContext | null | undefined;

/** Null outside a desktop shell with multi-window support. */
export function readDesktopWindowContext(): DesktopWindowContext | null {
  if (cachedContext === undefined) cachedContext = desktopWindowsBridge()?.getContext() ?? null;
  return cachedContext;
}

/** A secondary window hosts UI only; the main window's renderer owns its connections. */
export function isSecondaryDesktopWindow(): boolean {
  return readDesktopWindowContext()?.isMain === false;
}
