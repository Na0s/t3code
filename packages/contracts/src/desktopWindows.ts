import * as Schema from "effect/Schema";

/** The main window's profile. It always exists and cannot be deleted. */
export const DEFAULT_DESKTOP_WINDOW_PROFILE_ID = "main";

export const DesktopWindowProfileIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
);

export const DesktopWindowProfileNameSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
);

export const DesktopWindowProjectScopeKeysSchema = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
).check(Schema.isMaxLength(1000));

/** A theme preference id, or null for the main window's theme tinted with the filtered projects' icon colours. */
export const DesktopWindowProfileThemeSchema = Schema.NullOr(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
);

export const DesktopWindowProfileSchema = Schema.Struct({
  id: DesktopWindowProfileIdSchema,
  name: DesktopWindowProfileNameSchema,
  /** Unused for the default profile: the main window keeps its filter in its own UI state. */
  projectScopeKeys: DesktopWindowProjectScopeKeysSchema,
  theme: DesktopWindowProfileThemeSchema,
  isDefault: Schema.Boolean,
});
export type DesktopWindowProfile = typeof DesktopWindowProfileSchema.Type;

export const DesktopOpenWindowSchema = Schema.Struct({
  /** Electron's BrowserWindow id. */
  windowId: Schema.Int,
  isMain: Schema.Boolean,
  /** Null while a secondary window is unsaved. */
  profileId: Schema.NullOr(DesktopWindowProfileIdSchema),
  /** The profile name, or a generated "Window N" label for an unsaved window. */
  name: Schema.String,
  title: Schema.String,
  focused: Schema.Boolean,
  /** The window's current project filter; empty shows every project. */
  projectScopeKeys: DesktopWindowProjectScopeKeysSchema,
});
export type DesktopOpenWindow = typeof DesktopOpenWindowSchema.Type;

export const DesktopWindowsStateSchema = Schema.Struct({
  profiles: Schema.Array(DesktopWindowProfileSchema),
  windows: Schema.Array(DesktopOpenWindowSchema),
  miniMode: Schema.Boolean,
  /** Off: no new secondary windows open; windows already open stay open. */
  multiWindowEnabled: Schema.Boolean,
});
export type DesktopWindowsState = typeof DesktopWindowsStateSchema.Type;

/** Read synchronously at preload time; a window keeps its id and role for its lifetime. */
export const DesktopWindowContextSchema = Schema.Struct({
  windowId: Schema.Int,
  isMain: Schema.Boolean,
  /** The profile the window opened with; null for an unsaved secondary window. */
  profileId: Schema.NullOr(Schema.String),
  /** The profile's project filter at open time (secondary windows only). */
  projectScopeKeys: Schema.Array(Schema.String),
  /** The profile's theme override at open time; null follows the default profile. */
  theme: Schema.NullOr(Schema.String),
});
export type DesktopWindowContext = typeof DesktopWindowContextSchema.Type;

export const DesktopOpenWindowInputSchema = Schema.Struct({
  /** Seeds an unsaved window's project filter, such as the opener's current filter. */
  projectScopeKeys: Schema.optionalKey(DesktopWindowProjectScopeKeysSchema),
});
export type DesktopOpenWindowInput = typeof DesktopOpenWindowInputSchema.Type;

export const DesktopCreateWindowProfileInputSchema = Schema.Struct({
  name: DesktopWindowProfileNameSchema,
  projectScopeKeys: DesktopWindowProjectScopeKeysSchema,
  theme: DesktopWindowProfileThemeSchema,
});
export type DesktopCreateWindowProfileInput = typeof DesktopCreateWindowProfileInputSchema.Type;

export const DesktopUpdateWindowProfileInputSchema = Schema.Struct({
  profileId: DesktopWindowProfileIdSchema,
  name: Schema.optionalKey(DesktopWindowProfileNameSchema),
  theme: Schema.optionalKey(DesktopWindowProfileThemeSchema),
});
export type DesktopUpdateWindowProfileInput = typeof DesktopUpdateWindowProfileInputSchema.Type;

export const DesktopWindowCloseRequestSchema = Schema.Struct({
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  suggestedName: Schema.String,
});
export type DesktopWindowCloseRequest = typeof DesktopWindowCloseRequestSchema.Type;

export const DesktopWindowCloseDecisionSchema = Schema.Union([
  Schema.Struct({ action: Schema.Literal("save"), name: DesktopWindowProfileNameSchema }),
  Schema.Struct({ action: Schema.Literal("discard") }),
  Schema.Struct({ action: Schema.Literal("cancel") }),
]);
export type DesktopWindowCloseDecision = typeof DesktopWindowCloseDecisionSchema.Type;

export const DesktopResolveWindowCloseInputSchema = Schema.Struct({
  requestId: DesktopWindowCloseRequestSchema.fields.requestId,
  decision: DesktopWindowCloseDecisionSchema,
});

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

export interface DesktopWindowsBridge {
  getContext: () => DesktopWindowContext;
  getState: () => Promise<DesktopWindowsState>;
  onState: (listener: (state: DesktopWindowsState) => void) => () => void;
  openNew: (input?: DesktopOpenWindowInput) => Promise<void>;
  /** Focuses the profile's window when it is open, otherwise opens it. */
  openProfile: (profileId: string) => Promise<void>;
  focus: (windowId: number) => Promise<void>;
  /** Saves a profile without opening its window. */
  createProfile: (input: DesktopCreateWindowProfileInput) => Promise<DesktopWindowProfile>;
  /** Saves the calling window as a new profile. */
  saveAsProfile: (name: string) => Promise<DesktopWindowProfile>;
  updateProfile: (input: DesktopUpdateWindowProfileInput) => Promise<void>;
  /** An open window of a deleted profile stays open, unsaved. The default profile cannot be deleted. */
  deleteProfile: (profileId: string) => Promise<void>;
  /** The calling secondary window's filter; saved to its profile, or held for save-on-close. */
  setProjectScopeKeys: (projectScopeKeys: readonly string[]) => Promise<void>;
  /** Asks the calling window whether to save itself before it closes. */
  onCloseRequest: (listener: (request: DesktopWindowCloseRequest) => void) => () => void;
  resolveCloseRequest: (requestId: string, decision: DesktopWindowCloseDecision) => Promise<void>;
  setMiniMode: (enabled: boolean) => Promise<void>;
  setMultiWindowEnabled: (enabled: boolean) => Promise<void>;
  /** Main window only: its renderer serves secondary windows' environment connections. */
  registerHub: () => void;
  /** Secondary windows only: asks for a port to the hub, delivered as a `DesktopHubLinkMessage`. */
  requestHubLink: () => void;
  /** Hub side: a secondary window's renderer went away, so its links are dead. */
  onHubPeerGone: (listener: (windowId: number) => void) => () => void;
  /** Secondary side: the hub's renderer went away; drop links and request a new one. */
  onHubReset: (listener: () => void) => () => void;
}
