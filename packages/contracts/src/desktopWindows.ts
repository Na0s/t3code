import * as Schema from "effect/Schema";

export const DesktopOpenWindowSchema = Schema.Struct({
  /** Electron's BrowserWindow id. */
  windowId: Schema.Int,
  isMain: Schema.Boolean,
});
export type DesktopOpenWindow = typeof DesktopOpenWindowSchema.Type;

export const DesktopWindowsStateSchema = Schema.Struct({
  windows: Schema.Array(DesktopOpenWindowSchema),
});
export type DesktopWindowsState = typeof DesktopWindowsStateSchema.Type;

/** Read synchronously at preload time; a window keeps its id and role for its lifetime. */
export const DesktopWindowContextSchema = Schema.Struct({
  windowId: Schema.Int,
  isMain: Schema.Boolean,
});
export type DesktopWindowContext = typeof DesktopWindowContextSchema.Type;

/**
 * `window.postMessage` payload the preload uses to hand a hub link port to the page,
 * since a MessagePort cannot cross the context bridge. The port is `event.ports[0]`.
 */
export const DESKTOP_HUB_LINK_MESSAGE_TYPE = "t3code:desktop-hub-link";
export interface DesktopHubLinkMessage {
  readonly type: typeof DESKTOP_HUB_LINK_MESSAGE_TYPE;
  /** The BrowserWindow id at the other end of the port. */
  readonly peerWindowId: number;
}

export type DesktopBotWindowSize = "narrow" | "medium";

/** The single T3_BOT window: a floating, optionally always-on-top window showing the `/bot` route. */
export interface DesktopBotWindowBridge {
  /** Opens the bot window, or focuses it when it is already open. */
  open: () => Promise<void>;
  /** Bot window only: keep it above other apps' windows. */
  setPinned: (pinned: boolean) => Promise<void>;
  /** Bot window only. */
  setSize: (size: DesktopBotWindowSize) => Promise<void>;
}

export interface DesktopWindowsBridge {
  getContext: () => DesktopWindowContext;
  getState: () => Promise<DesktopWindowsState>;
  onState: (listener: (state: DesktopWindowsState) => void) => () => void;
  openNew: () => Promise<void>;
  /** Main window only: its renderer serves secondary windows' environment connections. */
  registerHub: () => void;
  /** Secondary windows only: asks for a port to the hub, delivered as a `DesktopHubLinkMessage`. */
  requestHubLink: () => void;
  /** Hub side: a secondary window's renderer went away, so its links are dead. */
  onHubPeerGone: (listener: (windowId: number) => void) => () => void;
  /** Secondary side: the hub's renderer went away; drop links and request a new one. */
  onHubReset: (listener: () => void) => () => void;
  /** Absent on desktop builds without the bot window. */
  bot?: DesktopBotWindowBridge;
}
