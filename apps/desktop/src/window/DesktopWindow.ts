import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as Electron from "electron";
import { msg } from "gt-i18n";

import {
  type DesktopBotWindowSize,
  type DesktopBotWindowState,
  type DesktopSnapShotEvent,
  type DesktopWindowContext,
  type DesktopWindowsState,
  DEFAULT_CLIENT_SETTINGS,
} from "@t3tools/contracts";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopClerk from "../app/DesktopClerk.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopPrimaryPaste from "../app/DesktopPrimaryPaste.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import { getDesktopOrigin, getDesktopUrl } from "../electron/ElectronProtocol.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import {
  MENU_ACTION_CHANNEL,
  QUIT_SHORTCUT_CHANNEL,
  SNAP_SHOT_EVENT_CHANNEL,
  TRACKPAD_SCROLL_BEGIN_CHANNEL,
  TRACKPAD_SCROLL_END_CHANNEL,
  WINDOW_FULLSCREEN_STATE_CHANNEL,
  WINDOWS_HUB_LINK_CHANNEL,
  WINDOWS_HUB_PEER_GONE_CHANNEL,
  WINDOWS_HUB_RESET_CHANNEL,
  WINDOWS_STATE_CHANNEL,
} from "../ipc/channels.ts";
import {
  PASSKEY_BRIDGE_ARGUMENT,
  PRIMARY_PASTE_DISABLED_ARGUMENT,
} from "../preview/GuestProtocol.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PreviewPasskeys from "../preview/Passkeys.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import { m } from "../i18n/messages.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import { makeQuitShortcutHandler } from "./QuitHold.ts";
import { copyContextMenuImage } from "./ContextMenuImage.ts";
import { installMainWindowRemoteRequestHeaderPolicy } from "./RemoteRequestHeaders.ts";
import { setUnthrottledHold } from "./BackgroundThrottling.ts";
import { HubLinkBroker, type HubLinkPeer } from "./DesktopHubLinks.ts";
import { cascadeWindowBounds, resizeWithinDisplay } from "./DesktopWindowProfiles.ts";

const TITLEBAR_HEIGHT = 40;

class ContextMenuImageCopyError extends Schema.TaggedError<ContextMenuImageCopyError>()(
  "ContextMenuImageCopyError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not copy the context-menu image.";
  }
}
// Match --workspace-topbar-height in apps/web/src/index.css; native macOS buttons stay 14 points at any zoom.
const MACOS_WORKSPACE_TOPBAR_HEIGHT = 52;
const MACOS_WINDOW_BUTTON_RADIUS = 7;

function parseMailtoAddress(rawUrl: string): Option.Option<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return Option.none();
  }
  if (url.protocol !== "mailto:" || url.pathname === "") return Option.none();
  try {
    return Option.some(decodeURIComponent(url.pathname));
  } catch {
    return Option.some(url.pathname);
  }
}

function syncMacosWindowButtons(window: Electron.BrowserWindow): void {
  if (window.isDestroyed() || window.isFullScreen()) return;
  window.setWindowButtonPosition({
    x: 16,
    y: Math.round(
      (MACOS_WORKSPACE_TOPBAR_HEIGHT * window.webContents.getZoomFactor()) / 2 -
        MACOS_WINDOW_BUTTON_RADIUS,
    ),
  });
}

const TITLEBAR_COLOR = "#01000000"; // #00000000 does not work correctly on Linux
const TITLEBAR_LIGHT_SYMBOL_COLOR = "#1f2937";
const TITLEBAR_DARK_SYMBOL_COLOR = "#f8fafc";
const MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS = 500;
const DEVELOPMENT_LOAD_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;
const RENDERER_RECOVERY_RELOAD_DELAY_MS = 500;
const RENDERER_RECOVERY_MAX_ATTEMPTS = 3;
const RENDERER_RECOVERY_WINDOW_MS = 60_000;
const DEVELOPMENT_RETRYABLE_LOAD_ERROR_CODES = new Set([-2, -7, -9, -102, -105, -106, -118]);
const HUB_UNTHROTTLED_REASON = "hub-serving-windows";

type WindowTitleBarOptions = Pick<
  Electron.BrowserWindowConstructorOptions,
  "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition"
>;

type DesktopWindowRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopState.DesktopState
  | DesktopAssets.DesktopAssets
  | DesktopAppSettings.DesktopAppSettings
  | DesktopClientSettings.DesktopClientSettings
  | ElectronApp.ElectronApp
  | ElectronMenu.ElectronMenu
  | ElectronShell.ElectronShell
  | ElectronTheme.ElectronTheme
  | ElectronWindow.ElectronWindow
  | DesktopRendererHistory.DesktopRendererHistory
  | PreviewManager.PreviewManager;

export type DesktopWindowError =
  | ElectronWindow.ElectronWindowCreateError
  | PreviewManager.PreviewManagerError;

export type MainWindowZoomDirection = "in" | "out" | "reset";
export type MainWindowContentsCommand = "reload" | "forceReload" | "toggleDevTools";

export class DesktopWindow extends Context.Service<
  DesktopWindow,
  {
    readonly createMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly ensureMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly revealOrCreateMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly activate: Effect.Effect<void, DesktopWindowError>;
    readonly createMainIfBackendReady: Effect.Effect<void, DesktopWindowError>;
    readonly showConnectingSplash: Effect.Effect<void>;
    readonly handleBackendReady: (httpBaseUrl: URL) => Effect.Effect<void, DesktopWindowError>;
    readonly handleBackendNotReady: Effect.Effect<void>;
    readonly flushMainWindowBounds: Effect.Effect<void>;
    readonly prepareCaptureReveal: Effect.Effect<void>;
    readonly dispatchMenuAction: (
      action: string,
      options?: { readonly reveal?: boolean },
    ) => Effect.Effect<void, DesktopWindowError>;
    readonly dispatchSnapShotEvent: (
      event: DesktopSnapShotEvent,
    ) => Effect.Effect<void, DesktopWindowError>;
    // Electron zoom roles target focused guests; this must always target an app window.
    readonly zoomFocused: (direction: MainWindowZoomDirection) => Effect.Effect<void>;
    readonly runMainContentsCommand: (command: MainWindowContentsCommand) => Effect.Effect<void>;
    readonly runFocusedContentsCommand: (command: MainWindowContentsCommand) => Effect.Effect<void>;
    readonly syncAppearance: Effect.Effect<void>;
    readonly windowsState: Effect.Effect<DesktopWindowsState>;
    readonly windowContext: (
      window: Electron.BrowserWindow,
    ) => Effect.Effect<Option.Option<DesktopWindowContext>>;
    readonly openNewWindow: Effect.Effect<void, DesktopWindowError>;
    /** Opens the single bot window, or brings it forward. */
    readonly openBot: Effect.Effect<void, DesktopWindowError>;
    /** No-ops unless `window` is the bot window. */
    readonly setBotSize: (
      window: Electron.BrowserWindow,
      size: DesktopBotWindowSize,
    ) => Effect.Effect<void>;
    /** No-ops unless `window` is the bot window. */
    readonly setBotPinned: (window: Electron.BrowserWindow, pinned: boolean) => Effect.Effect<void>;
    readonly registerHub: (window: Electron.BrowserWindow) => Effect.Effect<void>;
    readonly requestHubLink: (window: Electron.BrowserWindow) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopWindow") {}

const { logInfo: logWindowInfo, logWarning: logWindowWarning } =
  makeComponentLogger("desktop-window");

function getIconOption(
  iconPaths: DesktopAssets.DesktopIconPaths,
  platform: NodeJS.Platform,
): { icon: string } | Record<string, never> {
  if (platform === "darwin") return {};
  const ext = platform === "win32" ? "ico" : "png";
  return Option.match(iconPaths[ext], {
    onNone: () => ({}),
    onSome: (icon) => ({ icon }),
  });
}

function getInitialWindowBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? "#000000" : "#ffffff";
}

type DisplayBounds = Pick<Electron.Rectangle, "x" | "y" | "width" | "height">;

// A window snapped to a display edge can be reported 1px past that edge.
const SAVED_BOUNDS_EDGE_TOLERANCE_PX = 1;

function windowFitsWithinDisplay(
  windowBounds: DesktopAppSettings.DesktopWindowBounds,
  displayBounds: DisplayBounds,
): boolean {
  const tolerance = SAVED_BOUNDS_EDGE_TOLERANCE_PX;
  return (
    windowBounds.x >= displayBounds.x - tolerance &&
    windowBounds.y >= displayBounds.y - tolerance &&
    windowBounds.x + windowBounds.width <= displayBounds.x + displayBounds.width + tolerance &&
    windowBounds.y + windowBounds.height <= displayBounds.y + displayBounds.height + tolerance
  );
}

function overlapArea(left: DisplayBounds, right: DisplayBounds): number {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function displayMatching(
  bounds: DisplayBounds,
  displays: readonly DisplayBounds[],
): DisplayBounds | undefined {
  let match: DisplayBounds | undefined;
  let matchArea = 0;
  for (const display of displays) {
    const area = overlapArea(bounds, display);
    if (area > matchArea) {
      match = display;
      matchArea = area;
    }
  }
  return match;
}

// Normal bounds of a maximized window can sit on, or straddle into, another display than the window.
function normalBoundsOnWindowDisplay(
  normalBounds: DisplayBounds,
  windowBounds: DisplayBounds,
  displays: readonly DisplayBounds[],
): DisplayBounds {
  const target = displayMatching(windowBounds, displays);
  if (target === undefined || windowFitsWithinDisplay(normalBounds, target)) {
    return normalBounds;
  }
  const source = displayMatching(normalBounds, displays) ?? target;
  const width = Math.min(normalBounds.width, target.width);
  const height = Math.min(normalBounds.height, target.height);
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
  return {
    x: clamp(target.x + normalBounds.x - source.x, target.x, target.x + target.width - width),
    y: clamp(target.y + normalBounds.y - source.y, target.y, target.y + target.height - height),
    width,
    height,
  };
}

function readDisplayBoundsOrEmpty(): readonly DisplayBounds[] {
  try {
    return Electron.screen.getAllDisplays().map((display) => display.bounds);
  } catch {
    return [];
  }
}

function readDisplayWorkAreasOrEmpty(): readonly DisplayBounds[] {
  try {
    return Electron.screen.getAllDisplays().map((display) => display.workArea);
  } catch {
    return [];
  }
}

function windowBoundsEqual(
  left: DesktopAppSettings.DesktopWindowBounds,
  right: DesktopAppSettings.DesktopWindowBounds,
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

type WindowSize = { readonly width: number; readonly height: number };

export function resolveInitialMainWindowBounds(
  persistedBounds: DesktopAppSettings.DesktopWindowBounds | null,
  displays: readonly DisplayBounds[],
  defaultSize: WindowSize = DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE,
): DesktopAppSettings.DesktopWindowBounds | WindowSize {
  if (
    persistedBounds !== null &&
    displays.some((display) => windowFitsWithinDisplay(persistedBounds, display))
  ) {
    return persistedBounds;
  }
  return defaultSize;
}

function buildConnectingSplashDataUrl(shouldUseDarkColors: boolean): string {
  const background = getInitialWindowBackgroundColor(shouldUseDarkColors);
  const label = shouldUseDarkColors ? "#9ca3af" : "#6b7280";
  const accent = shouldUseDarkColors ? "#f8fafc" : "#1f2937";
  const track = shouldUseDarkColors ? "rgba(248,250,252,0.18)" : "rgba(31,41,55,0.18)";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;height:100%}body{background:${background};color:${label};font-family:system-ui,-apple-system,'Segoe UI',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;-webkit-user-select:none;user-select:none;-webkit-app-region:drag}.spinner{width:26px;height:26px;border:3px solid ${track};border-top-color:${accent};border-radius:50%;animation:spin .8s linear infinite}.label{font-size:13px}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div class="spinner"></div><div class="label">Connecting to WSL…</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function isSameOriginRendererNavigation(input: {
  readonly applicationUrl: string;
  readonly navigationUrl: string;
}): boolean {
  try {
    const applicationUrl = new URL(input.applicationUrl);
    const navigationUrl = new URL(input.navigationUrl);
    // Node serializes custom-scheme origins as "null", even for different hosts and schemes.
    return (
      applicationUrl.host !== "" &&
      navigationUrl.protocol === applicationUrl.protocol &&
      navigationUrl.host === applicationUrl.host
    );
  } catch {
    return false;
  }
}

function isRetryableDevelopmentRendererLoadFailure(input: {
  readonly applicationUrl: string;
  readonly errorCode: number;
  readonly isMainFrame: boolean;
  readonly validatedUrl: string;
}): boolean {
  return (
    input.isMainFrame &&
    DEVELOPMENT_RETRYABLE_LOAD_ERROR_CODES.has(input.errorCode) &&
    isSameOriginRendererNavigation({
      applicationUrl: input.applicationUrl,
      navigationUrl: input.validatedUrl,
    })
  );
}

function concealPendingQuitWindow(
  window: Pick<
    Electron.BrowserWindow,
    "isDestroyed" | "isFullScreen" | "setFullScreen" | "setOpacity"
  >,
): void {
  if (window.isDestroyed()) return;
  if (window.isFullScreen()) {
    window.setFullScreen(false);
  }
  // Linux lacks Electron window opacity; release-gated quits remain visible there.
  window.setOpacity(0);
}

function getWindowTitleBarOptions(
  shouldUseDarkColors: boolean,
  platform: NodeJS.Platform,
): WindowTitleBarOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: {
        x: 16,
        y: MACOS_WORKSPACE_TOPBAR_HEIGHT / 2 - MACOS_WINDOW_BUTTON_RADIUS,
      },
    };
  }

  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: TITLEBAR_COLOR,
      height: TITLEBAR_HEIGHT,
      symbolColor: shouldUseDarkColors ? TITLEBAR_DARK_SYMBOL_COLOR : TITLEBAR_LIGHT_SYMBOL_COLOR,
    },
  };
}

function syncWindowAppearance(
  window: Electron.BrowserWindow,
  hasTitleBarOverlay: boolean,
  shouldUseDarkColors: boolean,
  platform: NodeJS.Platform,
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (window.isDestroyed()) {
      return;
    }

    window.setBackgroundColor(getInitialWindowBackgroundColor(shouldUseDarkColors));
    const { titleBarOverlay } = getWindowTitleBarOptions(shouldUseDarkColors, platform);
    if (hasTitleBarOverlay && typeof titleBarOverlay === "object") {
      window.setTitleBarOverlay(titleBarOverlay);
    }
  });
}

type RevealSubscription = (listener: () => void) => void;

function bindFirstRevealTrigger(
  subscribers: readonly RevealSubscription[],
  reveal: () => void,
): void {
  let revealed = false;
  const fire = () => {
    if (revealed) return;
    revealed = true;
    reveal();
  };
  for (const subscribe of subscribers) {
    subscribe(fire);
  }
}

type AppWindowSpec =
  | { readonly role: "main" }
  | { readonly role: "secondary"; readonly anchorBounds: DisplayBounds | null }
  | { readonly role: "bot" };

interface AppWindowEntry {
  readonly window: Electron.BrowserWindow;
  readonly windowId: number;
  readonly isMain: boolean;
  readonly isBot: boolean;
  rendererLive: boolean;
  hubUnthrottled: boolean;
}

const serializeWindowsState = (state: DesktopWindowsState) => JSON.stringify(state);

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopState = yield* DesktopState.DesktopState;
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const previewManager = yield* PreviewManager.PreviewManager;
  const previewPasskeys = yield* PreviewPasskeys.PreviewPasskeys;
  const primaryPaste = yield* DesktopPrimaryPaste.DesktopPrimaryPaste;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const electronApp = yield* ElectronApp.ElectronApp;
  const rendererHistory = yield* DesktopRendererHistory.DesktopRendererHistory;
  const backendReadyRef = yield* Ref.make(false);
  let backendHasStarted = false;
  let mainClosedDuringStartup = false;
  const splashWindowRef = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
  const context = yield* Effect.context<DesktopWindowRuntimeServices>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  const runSync = Effect.runSyncWith(context);
  const mainWindowMutex = yield* Semaphore.make(1);
  const botWindowMutex = yield* Semaphore.make(1);
  // The bot window's renderer reads this at load; settings may refuse writes.
  let botState: DesktopBotWindowState = {
    size: DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS.botWindow.size,
    pinned: DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS.botWindow.pinned,
  };
  const pendingMainReveals = new WeakMap<Electron.BrowserWindow, Effect.Effect<void>>();
  const revealMain = Effect.fn("desktop.window.revealMain")((window: Electron.BrowserWindow) =>
    Effect.suspend(() => pendingMainReveals.get(window) ?? electronWindow.reveal(window)),
  );
  let flushMainWindowBounds: Effect.Effect<void> = Effect.void;
  let remoteRequestHeaderOwner: Electron.BrowserWindow | null = null;
  const entries = new Map<number, AppWindowEntry>();
  // macOS: float above other apps' windows, as the preview picture-in-picture window does.
  const applyBotPinned = (window: Electron.BrowserWindow, pinned: boolean) => {
    if (!pinned) window.setAlwaysOnTop(false);
    else window.setAlwaysOnTop(true, environment.platform === "darwin" ? "floating" : "normal");
  };
  let lastBroadcastState = "";
  const hubLinks = new HubLinkBroker<Electron.MessagePortMain>(
    () => new Electron.MessageChannelMain(),
  );

  const liveEntries = () => [...entries.values()].filter((entry) => !entry.window.isDestroyed());
  const mainEntry = () => liveEntries().find((entry) => entry.isMain);
  const secondaryEntries = () => liveEntries().filter((entry) => !entry.isMain);
  const botEntry = () => liveEntries().find((entry) => entry.isBot);
  const entryOf = (window: Electron.BrowserWindow) => {
    const entry = entries.get(window.id);
    return entry !== undefined && entry.window === window && !window.isDestroyed()
      ? entry
      : undefined;
  };

  const dismissConnectingSplash = Effect.gen(function* () {
    const splash = yield* Ref.getAndSet(splashWindowRef, Option.none());
    if (Option.isSome(splash) && !splash.value.isDestroyed()) {
      splash.value.close();
    }
  });

  // Electron's first-window fallback can select the unregistered connecting splash; exclude it so main creation retries.
  const withoutSplash = (window: Option.Option<Electron.BrowserWindow>) =>
    Ref.get(splashWindowRef).pipe(
      Effect.map((splash) =>
        Option.isSome(splash) && Option.isSome(window) && window.value === splash.value
          ? Option.none<Electron.BrowserWindow>()
          : window,
      ),
    );

  const currentMainWindow = electronWindow.currentMainOrFirst.pipe(Effect.flatMap(withoutSplash));

  const zoomWindow = Effect.fn("desktop.window.zoomWindow")(function* (
    window: Electron.BrowserWindow,
    direction: MainWindowZoomDirection,
  ) {
    const webContents = window.webContents;
    webContents.setZoomLevel(
      direction === "reset" ? 0 : webContents.getZoomLevel() + (direction === "in" ? 0.5 : -0.5),
    );
    if (environment.platform === "darwin") syncMacosWindowButtons(window);
    // App zoom propagates to guests; restore each preview's own zoom.
    yield* previewManager.reapplyZoom();
  });

  const computeWindowsState = Effect.sync((): DesktopWindowsState => ({
    windows: liveEntries()
      .sort((left, right) => Number(right.isMain) - Number(left.isMain))
      .map(({ windowId, isMain }) => ({ windowId, isMain })),
  }));

  // The hub must keep serving secondary windows while it is hidden or minimized.
  const syncHubThrottling = () => {
    const main = mainEntry();
    if (main === undefined) return;
    const held = secondaryEntries().length > 0;
    if (held === main.hubUnthrottled) return;
    main.hubUnthrottled = held;
    setUnthrottledHold(main.window, HUB_UNTHROTTLED_REASON, held);
  };

  // Throttling and every renderer's list of open windows follow from the open windows.
  const syncWindows = Effect.fn("desktop.window.syncWindows")(function* () {
    syncHubThrottling();
    const state = yield* computeWindowsState;
    const serialized = serializeWindowsState(state);
    if (serialized === lastBroadcastState) return;
    lastBroadcastState = serialized;
    for (const entry of liveEntries()) {
      if (entry.rendererLive) entry.window.webContents.send(WINDOWS_STATE_CHANNEL, state);
    }
  });
  const requestSync = () => {
    runFork(syncWindows());
  };

  const notifyHubReset = () => {
    if (!hubLinks.resetHub()) return;
    for (const entry of secondaryEntries()) {
      if (entry.rendererLive) entry.window.webContents.send(WINDOWS_HUB_RESET_CHANNEL);
    }
  };
  const notifyHubPeerGone = (windowId: number) => {
    if (!hubLinks.peerGone(windowId)) return;
    const main = mainEntry();
    if (main !== undefined) main.window.webContents.send(WINDOWS_HUB_PEER_GONE_CHANNEL, windowId);
  };
  const hubPeer = (entry: AppWindowEntry): HubLinkPeer<Electron.MessagePortMain> => ({
    windowId: entry.windowId,
    deliver: (port, peerWindowId) => {
      if (entry.window.isDestroyed()) {
        port.close();
        return;
      }
      entry.window.webContents.postMessage(WINDOWS_HUB_LINK_CHANNEL, { peerWindowId }, [port]);
    },
  });

  const readDisplayBounds = Effect.gen(function* () {
    const displayBoundsResult = yield* Effect.sync(() => {
      try {
        return {
          _tag: "Success" as const,
          bounds: Electron.screen.getAllDisplays().map((display) => display.bounds),
        };
      } catch (cause) {
        return { _tag: "Failure" as const, cause };
      }
    });
    return displayBoundsResult._tag === "Success"
      ? displayBoundsResult.bounds
      : yield* logWindowWarning("failed to read connected displays; using defaults", {
          cause: displayBoundsResult.cause,
        }).pipe(Effect.as<readonly Electron.Rectangle[]>([]));
  });

  const buildAppWindow = Effect.fn("desktop.window.createWindow")(function* (
    spec: AppWindowSpec,
  ): Effect.fn.Return<Option.Option<Electron.BrowserWindow>, DesktopWindowError> {
    if (yield* Ref.get(desktopState.quitting)) return Option.none();
    const isMain = spec.role === "main";
    const isBot = spec.role === "bot";
    yield* previewManager.getBrowserSession();
    const applicationUrl = getDesktopUrl(environment.isDevelopment);
    const iconPaths = yield* assets.iconPaths;
    const iconOption = getIconOption(iconPaths, environment.platform);
    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
    const persistedSettings = yield* desktopSettings.get;
    // Only the main and bot windows keep their placement.
    const persistedBounds = isMain
      ? persistedSettings.mainWindowBounds
      : isBot
        ? persistedSettings.botWindow.bounds
        : null;
    const displayBounds = yield* readDisplayBounds;
    const restorableBounds = resolveInitialMainWindowBounds(
      persistedBounds,
      displayBounds,
      isBot
        ? DesktopAppSettings.BOT_WINDOW_SIZES[persistedSettings.botWindow.size]
        : DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE,
    );
    const restoredPersistedBounds =
      persistedBounds !== null && restorableBounds === persistedBounds;
    if (persistedBounds !== null && !restoredPersistedBounds) {
      yield* logWindowWarning("saved window bounds could not be restored; using defaults", {
        role: spec.role,
      });
    }
    const initialBounds =
      spec.role === "secondary"
        ? cascadeWindowBounds({
            anchor: spec.anchorBounds,
            size: DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE,
            displays: displayBounds,
          })
        : restorableBounds;
    if (yield* Ref.get(desktopState.quitting)) return Option.none();
    const minimumSize = isBot
      ? DesktopAppSettings.MIN_BOT_WINDOW_SIZE
      : DesktopAppSettings.MIN_MAIN_WINDOW_SIZE;
    const window = yield* electronWindow.create({
      ...initialBounds,
      minWidth: minimumSize.width,
      minHeight: minimumSize.height,
      // The bot window stays compact; its sizes are presets.
      ...(isBot ? { maximizable: false, fullscreenable: false } : {}),
      show: false,
      autoHideMenuBar: true,
      ...(environment.platform === "darwin" ? { disableAutoHideCursor: true } : {}),
      backgroundColor: getInitialWindowBackgroundColor(shouldUseDarkColors),
      ...iconOption,
      title: environment.displayName,
      ...getWindowTitleBarOptions(shouldUseDarkColors, environment.platform),
      webPreferences: {
        preload: environment.preloadPath,
        // Hidden-renderer throttling stalls first paint; re-enable it after the first reveal.
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true,
        // Guest fullscreen propagates to the embedder; both must opt out to keep it inside the webview.
        // The app's own fullscreen elements reach OS fullscreen through syncHtmlFullscreen.
        disableHtmlFullscreenWindowResize: true,
      },
    });
    if (yield* Ref.get(desktopState.quitting)) {
      yield* electronWindow.destroyAll;
      return Option.none();
    }

    if (isMain) pendingMainReveals.set(window, Effect.void);
    if (isBot) {
      botState = {
        size: persistedSettings.botWindow.size,
        pinned: persistedSettings.botWindow.pinned,
      };
      if (botState.pinned) applyBotPinned(window, true);
    }
    setUnthrottledHold(window, "first-reveal", true);
    yield* rendererHistory.register(window.webContents, { surface: "main" });
    if (environment.platform === "darwin") {
      window.setAutoHideCursor(false);
    }
    const entry: AppWindowEntry = {
      window,
      windowId: window.id,
      isMain,
      isBot,
      rendererLive: false,
      hubUnthrottled: false,
    };
    let boundsPersistFiber: Fiber.Fiber<void, never> | undefined;
    let pendingBoundsPersistFiber: Fiber.Fiber<void, never> | undefined;
    let boundsPersistenceEnabled = persistedBounds === null || restoredPersistedBounds;
    let lastPersistableState: {
      readonly bounds: DesktopAppSettings.DesktopWindowBounds;
      readonly isMaximized: boolean;
    } | null = null;
    const readPersistableState = () => {
      if (window.isDestroyed()) {
        return null;
      }
      // Minimized windows report stale state on some platforms (macOS: not maximized, the
      // pre-move normal frame; Windows: -32000), so they keep the state seen before minimizing.
      if (window.isMinimized()) {
        return lastPersistableState;
      }
      const isMaximized = window.isMaximized();
      const bounds =
        window.isFullScreen() || isMaximized
          ? normalBoundsOnWindowDisplay(
              window.getNormalBounds(),
              window.getBounds(),
              readDisplayBoundsOrEmpty(),
            )
          : window.getBounds();
      const normalizeBounds = isBot
        ? DesktopAppSettings.normalizeBotWindowBounds
        : DesktopAppSettings.normalizeMainWindowBounds;
      const persistableBounds = normalizeBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
      lastPersistableState =
        persistableBounds === null ? null : { bounds: persistableBounds, isMaximized };
      return lastPersistableState;
    };
    const fallbackWindowBounds = boundsPersistenceEnabled
      ? null
      : (readPersistableState()?.bounds ?? null);
    const fallbackWindowMaximized = isMain && persistedSettings.mainWindowMaximized;
    const persistCurrentBounds = (): Fiber.Fiber<void, never> | undefined => {
      if ((!isMain && !isBot) || !boundsPersistenceEnabled) {
        return pendingBoundsPersistFiber;
      }
      const state = readPersistableState();
      if (state === null) {
        return pendingBoundsPersistFiber;
      }
      pendingBoundsPersistFiber = runFork(
        (isBot
          ? desktopSettings.updateBotWindow({ bounds: state.bounds })
          : desktopSettings.setMainWindowBounds(state.bounds, state.isMaximized)
        ).pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            logWindowWarning("failed to persist window bounds", {
              role: spec.role,
              message: error.message,
            }),
          ),
        ),
      );
      return pendingBoundsPersistFiber;
    };
    const scheduleBoundsPersist = () => {
      const state = readPersistableState();
      if (
        !boundsPersistenceEnabled &&
        (state === null ||
          (fallbackWindowBounds !== null &&
            windowBoundsEqual(state.bounds, fallbackWindowBounds) &&
            state.isMaximized === fallbackWindowMaximized))
      ) {
        return;
      }
      boundsPersistenceEnabled = true;
      if (boundsPersistFiber !== undefined) {
        const fiber = boundsPersistFiber;
        boundsPersistFiber = undefined;
        runFork(Fiber.interrupt(fiber));
      }
      boundsPersistFiber = runFork(
        Effect.sleep(MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS).pipe(
          Effect.andThen(
            Effect.sync(() => {
              boundsPersistFiber = undefined;
              void persistCurrentBounds();
            }),
          ),
        ),
      );
    };
    const clearBoundsPersist = () => {
      if (boundsPersistFiber === undefined) {
        return;
      }
      const fiber = boundsPersistFiber;
      boundsPersistFiber = undefined;
      runFork(Fiber.interrupt(fiber));
    };
    const flushBoundsPersist = Effect.sync(() => {
      clearBoundsPersist();
      return persistCurrentBounds();
    }).pipe(
      Effect.flatMap((fiber) =>
        fiber === undefined ? Effect.void : Fiber.join(fiber).pipe(Effect.asVoid),
      ),
    );
    if (isMain) flushMainWindowBounds = flushBoundsPersist;

    if (isMain) {
      yield* previewManager.setMainWindow(window);
    } else {
      yield* previewManager.registerSecondaryWindow(window);
    }
    if (yield* Ref.get(desktopState.quitting)) {
      yield* electronWindow.destroyAll;
      return Option.none();
    }
    window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
      if (
        typeof params.partition !== "string" ||
        !previewManager.isBrowserPartition(params.partition)
      ) {
        event.preventDefault();
        return;
      }
      webPreferences.sandbox = true;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = false;
      webPreferences.disableHtmlFullscreenWindowResize = true;
      if (previewPasskeys.bridgeEnabled) {
        webPreferences.additionalArguments = [
          ...(webPreferences.additionalArguments ?? []),
          PASSKEY_BRIDGE_ARGUMENT,
        ];
      }
      if (!primaryPaste.enabled) {
        webPreferences.additionalArguments = [
          ...(webPreferences.additionalArguments ?? []),
          PRIMARY_PASTE_DISABLED_ARGUMENT,
        ];
      }
    });

    const contextMenuContents = new WeakSet<Electron.WebContents>();
    const installContextMenu = (
      ownerWindow: Electron.BrowserWindow,
      contents: Electron.WebContents,
      isBrowserContents = false,
    ): void => {
      if (contextMenuContents.has(contents)) return;
      contextMenuContents.add(contents);
      contents.on("context-menu", (event, params) => {
        event.preventDefault();
        if (contents.isDestroyed() || ownerWindow.isDestroyed()) return;
        // Right-clicking a guest may leave native editing roles targeting the host renderer.
        contents.focus();

        const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

        if (isBrowserContents) {
          menuTemplate.push(
            {
              label: m(msg("Reload")),
              click: () => {
                if (!contents.isDestroyed()) contents.reload();
              },
            },
            { type: "separator" },
          );
        }

        if (params.misspelledWord) {
          for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
            menuTemplate.push({
              label: suggestion,
              click: () => {
                if (!contents.isDestroyed()) contents.replaceMisspelling(suggestion);
              },
            });
          }
          if (params.dictionarySuggestions.length === 0) {
            menuTemplate.push({ label: m(msg("No suggestions")), enabled: false });
          }
          menuTemplate.push({ type: "separator" });
        }

        if (Option.isSome(ElectronShell.parseSafeExternalUrl(params.linkURL))) {
          menuTemplate.push(
            {
              label: m(msg("Copy Link")),
              click: () => {
                void runPromise(electronShell.copyText(params.linkURL));
              },
            },
            { type: "separator" },
          );
        }

        const mailtoAddress = parseMailtoAddress(params.linkURL);
        if (Option.isSome(mailtoAddress)) {
          menuTemplate.push(
            {
              label: m(msg("Copy Email Address")),
              click: () => {
                void runPromise(electronShell.copyText(mailtoAddress.value));
              },
            },
            { type: "separator" },
          );
        }

        if (params.mediaType === "image") {
          menuTemplate.push({
            label: m(msg("Copy Image")),
            click: () => {
              void runPromise(
                Effect.tryPromise({
                  try: () => copyContextMenuImage(contents, params),
                  catch: (cause) => new ContextMenuImageCopyError({ cause }),
                }).pipe(Effect.catch(() => logWindowWarning("failed to copy context-menu image"))),
              );
            },
          });
          menuTemplate.push({ type: "separator" });
        }

        menuTemplate.push(
          {
            role: "cut",
            label: m(msg("Cut", { $context: "Edit menu item" })),
            enabled: params.editFlags.canCut,
          },
          {
            role: "copy",
            label: m(msg("Copy", { $context: "Edit menu item" })),
            enabled: params.editFlags.canCopy,
          },
          {
            role: "paste",
            label: m(msg("Paste", { $context: "Edit menu item" })),
            enabled: params.editFlags.canPaste,
          },
          {
            role: "selectAll",
            label: m(msg("Select All", { $context: "Edit menu item" })),
            enabled: params.editFlags.canSelectAll,
          },
        );

        void runPromise(
          electronMenu.popupTemplate({
            window: ownerWindow,
            template: menuTemplate,
            ...(params.frame ? { frame: params.frame } : {}),
          }),
        );
      });
      contents.on("did-create-window", (popup) => {
        installContextMenu(popup, popup.webContents, isBrowserContents);
      });
    };
    installContextMenu(window, window.webContents);
    window.webContents.on("did-attach-webview", (_event, contents) => {
      installContextMenu(window, contents, true);
      void runPromise(previewManager.prepareWebview(contents));
    });

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
        void runPromise(electronShell.openExternal(url));
      }
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (
        isSameOriginRendererNavigation({
          applicationUrl,
          navigationUrl: url,
        })
      ) {
        return;
      }

      event.preventDefault();
      if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
        void runPromise(electronShell.openExternal(url));
      }
    });
    // A new document drops the old renderer's hub links.
    const rendererGone = () => {
      entry.rendererLive = false;
      if (isMain) notifyHubReset();
      else notifyHubPeerGone(entry.windowId);
    };
    window.webContents.on("did-start-navigation", (event) => {
      if (event.isMainFrame && !event.isSameDocument) rendererGone();
    });
    window.webContents.on("destroyed", rendererGone);

    const quitShortcutHandler = makeQuitShortcutHandler({
      platform: environment.platform,
      getMode: () =>
        runPromise(
          Effect.map(
            clientSettings.get,
            Option.match({
              onNone: () => DEFAULT_CLIENT_SETTINGS.confirmQuit,
              onSome: (settings) => settings.confirmQuit,
            }),
          ),
        ),
      notify: (hint) => {
        if (!window.isDestroyed()) {
          window.webContents.send(QUIT_SHORTCUT_CHANNEL, hint);
        }
      },
      // Hold focus until shortcut release so remaining repeats cannot reach the next app.
      concealWindow: () => concealPendingQuitWindow(window),
      quit: () => {
        void runPromise(electronApp.quit);
      },
    });
    window.webContents.on("before-input-event", (event, input) => {
      quitShortcutHandler(event, input);
      if (window.isDestroyed()) return;
      // Cmd/Ctrl+W reaches the renderer; DevTools uses the native menu shortcut.
      window.webContents.setIgnoreMenuShortcuts(
        (environment.platform === "darwin" ? input.meta : input.control) &&
          !input.alt &&
          !input.shift &&
          input.key.toLowerCase() === "w",
      );
      // A held Cmd/Ctrl+W closes one tab or terminal, not each one behind it.
      if (input.type !== "keyDown" || !input.isAutoRepeat) return;
      const modifier = environment.platform === "darwin" ? input.meta : input.control;
      if (modifier && !input.alt && !input.shift && input.key.toLowerCase() === "w") {
        event.preventDefault();
      }
    });
    window.webContents.on("input-event", (_event, input) => {
      if (window.isDestroyed()) return;
      if (input.type === "gestureScrollBegin") {
        window.webContents.send(TRACKPAD_SCROLL_BEGIN_CHANNEL);
      } else if (input.type === "gestureScrollEnd") {
        window.webContents.send(TRACKPAD_SCROLL_END_CHANNEL);
      }
    });
    // Ctrl+wheel bypasses menus; guest contents emit their own zoom-changed event.
    window.webContents.on("zoom-changed", (_event, direction) => {
      if (window.isDestroyed()) return;
      runFork(zoomWindow(window, direction));
    });

    // The renderer titles the window after the open thread; only a blank title
    // falls back to the app name.
    window.on("page-title-updated", (event, title) => {
      if (title.trim() !== "") return;
      event.preventDefault();
      window.setTitle(environment.displayName);
    });
    window.on("resize", scheduleBoundsPersist);
    window.on("move", scheduleBoundsPersist);
    window.on("maximize", scheduleBoundsPersist);
    window.on("unmaximize", scheduleBoundsPersist);
    window.on("close", (event) => {
      // Hidden, the main window keeps serving the secondary windows' connections.
      if (isMain && secondaryEntries().length > 0 && !runSync(Ref.get(desktopState.quitting))) {
        event.preventDefault();
        window.hide();
        return;
      }
      runFork(flushBoundsPersist);
    });

    if (environment.platform === "darwin") {
      // Mouse drivers can deliver Back/Forward as macOS swipe gestures instead of buttons.
      window.on("swipe", (_event, direction) => {
        const history = window.webContents.navigationHistory;
        if (direction === "left" && history.canGoBack()) history.goBack();
        else if (direction === "right" && history.canGoForward()) history.goForward();
      });
      window.on("enter-full-screen", () => {
        window.webContents.send(WINDOW_FULLSCREEN_STATE_CHANNEL, true);
      });
      window.on("leave-full-screen", () => {
        syncMacosWindowButtons(window);
        window.webContents.send(WINDOW_FULLSCREEN_STATE_CHANNEL, false);
      });
    }

    let developmentLoadRetryIndex = 0;
    let developmentLoadRetryFiber: Fiber.Fiber<void, never> | undefined;
    let rendererRecoveryTimestamps: number[] = [];
    const clearDevelopmentLoadRetry = () => {
      if (developmentLoadRetryFiber === undefined) {
        return;
      }
      const retryFiber = developmentLoadRetryFiber;
      developmentLoadRetryFiber = undefined;
      runFork(Fiber.interrupt(retryFiber));
    };
    // Electron renderers use hash history, so a route is the URL fragment.
    const windowUrl = isBot ? `${applicationUrl}#/bot` : applicationUrl;
    const loadApplication = () => {
      if (window.isDestroyed()) {
        return;
      }
      void window.loadURL(windowUrl).catch(() => undefined);
    };
    const scheduleDevelopmentLoadRetry = () => {
      if (developmentLoadRetryFiber !== undefined || window.isDestroyed()) {
        return undefined;
      }

      const retryIndex = Math.min(
        developmentLoadRetryIndex,
        DEVELOPMENT_LOAD_RETRY_DELAYS_MS.length - 1,
      );
      const retryInMs = DEVELOPMENT_LOAD_RETRY_DELAYS_MS[retryIndex] ?? 2_000;
      developmentLoadRetryIndex += 1;
      developmentLoadRetryFiber = runFork(
        Effect.sleep(retryInMs).pipe(
          Effect.andThen(
            Effect.sync(() => {
              developmentLoadRetryFiber = undefined;
              if (!window.isDestroyed()) {
                loadApplication();
              }
            }),
          ),
        ),
      );
      return retryInMs;
    };

    window.webContents.on("did-finish-load", () => {
      if (
        environment.isDevelopment &&
        !isSameOriginRendererNavigation({
          applicationUrl,
          navigationUrl: window.webContents.getURL(),
        })
      ) {
        return;
      }
      clearDevelopmentLoadRetry();
      developmentLoadRetryIndex = 0;
      if (environment.platform === "darwin") syncMacosWindowButtons(window);
      entry.rendererLive = true;
      if (entries.size > 1 || !isMain) {
        lastBroadcastState = "";
        requestSync();
      }
    });
    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        const retryInMs =
          environment.isDevelopment &&
          isRetryableDevelopmentRendererLoadFailure({
            applicationUrl,
            errorCode,
            isMainFrame,
            validatedUrl: validatedURL,
          })
            ? scheduleDevelopmentLoadRetry()
            : undefined;
        void runPromise(
          logWindowWarning("app window failed to load", {
            role: spec.role,
            errorCode,
            errorDescription,
            url: validatedURL,
            ...(retryInMs === undefined ? {} : { retryInMs }),
          }),
        );
      },
    );
    window.webContents.on("render-process-gone", (_event, details) => {
      rendererGone();
      const recoverable =
        details.reason === "crashed" ||
        details.reason === "oom" ||
        details.reason === "killed" ||
        details.reason === "abnormal-exit";

      runFork(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          rendererRecoveryTimestamps = rendererRecoveryTimestamps.filter(
            (timestamp) => now - timestamp < RENDERER_RECOVERY_WINDOW_MS,
          );
          const shouldRecover = recoverable && !window.isDestroyed();
          // Past the budget, wait for the oldest attempt to leave the window instead of
          // giving up, so a crash loop backs off but never leaves the window blank.
          const oldestAttempt =
            rendererRecoveryTimestamps.length >= RENDERER_RECOVERY_MAX_ATTEMPTS
              ? rendererRecoveryTimestamps[
                  rendererRecoveryTimestamps.length - RENDERER_RECOVERY_MAX_ATTEMPTS
                ]
              : undefined;
          const reloadInMs =
            oldestAttempt === undefined
              ? RENDERER_RECOVERY_RELOAD_DELAY_MS
              : Math.max(
                  RENDERER_RECOVERY_RELOAD_DELAY_MS,
                  oldestAttempt + RENDERER_RECOVERY_WINDOW_MS - now,
                );
          yield* logWindowWarning("app window render process gone", {
            role: spec.role,
            reason: details.reason,
            exitCode: details.exitCode,
            recovering: shouldRecover,
            ...(shouldRecover ? { reloadInMs } : {}),
          });
          if (!shouldRecover) {
            return;
          }
          rendererRecoveryTimestamps.push(now + reloadInMs);
          yield* Effect.sleep(reloadInMs);
          if (!window.isDestroyed()) {
            loadApplication();
          }
        }),
      );
    });

    const revealSubscribers: RevealSubscription[] = [(fire) => window.once("ready-to-show", fire)];
    if (environment.platform === "linux") {
      revealSubscribers.push((fire) => window.webContents.once("did-finish-load", fire));
    }
    let rendererReady = false;
    let firstRevealComplete = false;
    const revealWhenReady = Effect.gen(function* () {
      if (
        !rendererReady ||
        firstRevealComplete ||
        window.isDestroyed() ||
        (yield* Ref.get(desktopState.quitting))
      )
        return;
      firstRevealComplete = true;
      pendingMainReveals.delete(window);
      setUnthrottledHold(window, "first-reveal", false);
      if (isMain && persistedSettings.mainWindowMaximized) window.maximize();
      yield* electronWindow.reveal(window);
      if (isMain) yield* dismissConnectingSplash;
    });
    if (isMain) pendingMainReveals.set(window, revealWhenReady);
    bindFirstRevealTrigger(revealSubscribers, () => {
      rendererReady = true;
      void runPromise(revealWhenReady);
    });

    entries.set(window.id, entry);
    // Desktop IPC only answers app windows, so register this one before its renderer can call in.
    let detachRemoteRequestHeaders = () => {};
    if (isMain) {
      yield* electronWindow.setMain(window);
      // App windows share one session, whose single header listener follows the main window.
      remoteRequestHeaderOwner = window;
      detachRemoteRequestHeaders = installMainWindowRemoteRequestHeaderPolicy(
        window.webContents.session,
        {
          desktopOrigin: getDesktopOrigin(environment.isDevelopment),
          mainWebContentsId: window.webContents.id,
          clerkFrontendApiHostname: DesktopClerk.desktopClerkFrontendApiHostname,
          devServerOrigin: Option.getOrUndefined(
            Option.map(environment.devServerUrl, (url) => url.origin),
          ),
          isDevelopment: environment.isDevelopment,
        },
      );
    } else {
      yield* electronWindow.registerApp(window);
    }
    yield* syncWindows();
    loadApplication();
    if (isMain && environment.isDevelopment) {
      window.webContents.openDevTools({ mode: "detach" });
    }

    window.on("closed", () => {
      if (entries.get(window.id) === entry) entries.delete(window.id);
      clearDevelopmentLoadRetry();
      clearBoundsPersist();
      if (remoteRequestHeaderOwner === window) {
        remoteRequestHeaderOwner = null;
        detachRemoteRequestHeaders();
      }
      if (isMain) {
        if (!backendHasStarted) mainClosedDuringStartup = true;
        notifyHubReset();
        void runPromise(electronWindow.clearMain(Option.some(window)));
      } else {
        notifyHubPeerGone(entry.windowId);
        runFork(handleSecondaryClosed);
      }
      requestSync();
    });

    return Option.some(window);
  });

  const createMain = Effect.gen(function* () {
    const window = yield* buildAppWindow({ role: "main" });
    if (Option.isSome(window)) {
      mainClosedDuringStartup = false;
      yield* logWindowInfo("main window created");
    }
    return window;
  }).pipe(Effect.withSpan("desktop.window.createMain"));

  const ensureMain = Effect.gen(function* () {
    if (yield* Ref.get(desktopState.quitting)) return Option.none<Electron.BrowserWindow>();
    const existingWindow = yield* electronWindow.main;
    if (Option.isSome(existingWindow)) {
      return existingWindow;
    }
    return yield* createMain;
  }).pipe(mainWindowMutex.withPermits(1), Effect.withSpan("desktop.window.ensureMain"));

  const requireWindow = (window: Option.Option<Electron.BrowserWindow>) =>
    Option.match(window, {
      onNone: () => Effect.interrupt,
      onSome: Effect.succeed,
    });

  const revealOrCreateMain = Effect.gen(function* () {
    const window = yield* ensureMain.pipe(Effect.flatMap(requireWindow));
    yield* revealMain(window);
    return window;
  }).pipe(Effect.withSpan("desktop.window.revealOrCreateMain"));

  const openSecondary = Effect.gen(function* () {
    // Secondary windows reach environments through the main window's renderer.
    if (Option.isNone(yield* ensureMain)) return;
    const anchor = yield* electronWindow.focusedApp;
    yield* buildAppWindow({
      role: "secondary",
      anchorBounds:
        Option.isSome(anchor) && !anchor.value.isDestroyed() ? anchor.value.getBounds() : null,
    });
  }).pipe(Effect.withSpan("desktop.window.openSecondary"));

  const openBot = Effect.gen(function* () {
    const existing = botEntry();
    if (existing !== undefined) {
      yield* electronWindow.reveal(existing.window);
      return;
    }
    // Like menu actions, wait for the backend rather than strand a new main window on auth.
    if (Option.isNone(yield* electronWindow.main) && (yield* waitingForBackend)) return;
    // The bot window reaches environments through the main window's renderer.
    if (Option.isNone(yield* ensureMain)) return;
    yield* buildAppWindow({ role: "bot" });
  }).pipe(botWindowMutex.withPermits(1), Effect.withSpan("desktop.window.openBot"));

  const persistBotWindow = (patch: Partial<DesktopAppSettings.DesktopBotWindowSettings>) =>
    desktopSettings.updateBotWindow(patch).pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        logWindowWarning("failed to persist bot window settings", { message: error.message }),
      ),
    );

  const handleSecondaryClosed = Effect.gen(function* () {
    if (yield* Ref.get(desktopState.quitting)) return;
    const main = mainEntry();
    if (secondaryEntries().length > 0 || main === undefined || main.window.isVisible()) return;
    // The hidden main window kept the app alive for its secondary windows; without them, quit
    // as closing the last window always has. macOS apps outlive their windows.
    if (environment.platform !== "darwin") main.window.close();
  }).pipe(Effect.withSpan("desktop.window.handleSecondaryClosed"));

  const waitingForBackend = Effect.gen(function* () {
    if (yield* Ref.get(backendReadyRef)) return false;
    return (yield* desktopSettings.get).localEnvironmentEnabled;
  });

  const createMainIfBackendReady = Effect.gen(function* () {
    if (yield* Ref.get(desktopState.quitting)) return;
    if (yield* waitingForBackend) return;
    yield* ensureMain;
  }).pipe(Effect.withSpan("desktop.window.createMainIfBackendReady"));

  const showConnectingSplash = Effect.gen(function* () {
    if (yield* Ref.get(desktopState.quitting)) return;
    const existingSplash = yield* Ref.get(splashWindowRef);
    if (Option.isSome(existingSplash)) return;
    const existingWindow = yield* electronWindow.currentMainOrFirst;
    if (Option.isSome(existingWindow)) return;

    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
    if (yield* Ref.get(desktopState.quitting)) return;
    const splash = yield* electronWindow.create({
      width: 360,
      height: 220,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      center: true,
      show: false,
      skipTaskbar: false,
      backgroundColor: getInitialWindowBackgroundColor(shouldUseDarkColors),
      title: environment.displayName,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    if (yield* Ref.get(desktopState.quitting)) {
      yield* electronWindow.destroyAll;
      return;
    }
    yield* rendererHistory.register(splash.webContents, { surface: "splash" });
    yield* Ref.set(splashWindowRef, Option.some(splash));
    splash.once("closed", () => {
      void runPromise(Ref.set(splashWindowRef, Option.none()));
    });
    splash.once("ready-to-show", () => {
      if (!splash.isDestroyed()) {
        splash.show();
      }
    });
    void splash.loadURL(buildConnectingSplashDataUrl(shouldUseDarkColors));
    yield* logWindowInfo("connecting splash shown");
  }).pipe(
    Effect.catch((error) =>
      logWindowWarning("failed to show connecting splash", { message: error.message }),
    ),
    Effect.withSpan("desktop.window.showConnectingSplash"),
  );

  const dispatchRendererEvent = Effect.fn("desktop.window.dispatchRendererEvent")(function* (
    channel: string,
    payload: unknown,
    {
      reveal = true,
      target,
    }: { readonly reveal?: boolean; readonly target?: Electron.BrowserWindow } = {},
  ): Effect.fn.Return<Option.Option<Electron.BrowserWindow>, DesktopWindowError> {
    if (yield* Ref.get(desktopState.quitting)) return Option.none();
    // Only app renderers load the preload that listens on these channels; the focused one acts.
    const existingWindow =
      target !== undefined && !target.isDestroyed()
        ? Option.some(target)
        : yield* electronWindow.focusedApp;
    if (Option.isNone(existingWindow) && (!reveal || (yield* waitingForBackend))) {
      return Option.none();
    }
    const window = Option.isSome(existingWindow) ? existingWindow : yield* ensureMain;
    if (Option.isNone(window) || window.value.isDestroyed()) return Option.none();
    const targetWindow = window.value;
    const send = Effect.sync(() => {
      if (!targetWindow.isDestroyed()) targetWindow.webContents.send(channel, payload);
    });
    // Send before best-effort reveal; another process may refuse to yield foreground focus.
    const dispatch = reveal
      ? send.pipe(Effect.andThen(revealMain(targetWindow).pipe(Effect.ignoreCause)))
      : send;
    if (targetWindow.webContents.isLoadingMainFrame()) {
      targetWindow.webContents.once("did-finish-load", () => void runPromise(dispatch));
      return window;
    }
    yield* dispatch;
    return window;
  });
  // A capture finishes in the window it started in, even if focus moved meanwhile.
  const captureWindows = new Map<string, Electron.BrowserWindow>();

  const runContentsCommand = (
    window: Electron.BrowserWindow,
    command: MainWindowContentsCommand,
  ) => {
    if (window.isDestroyed()) return;
    const webContents = window.webContents;
    if (command === "reload") webContents.reload();
    else if (command === "forceReload") webContents.reloadIgnoringCache();
    else webContents.toggleDevTools();
  };

  return DesktopWindow.of({
    createMain: createMain.pipe(Effect.flatMap(requireWindow)),
    ensureMain: ensureMain.pipe(Effect.flatMap(requireWindow)),
    revealOrCreateMain,
    prepareCaptureReveal: Effect.gen(function* () {
      // The capture lands in the focused app window, so that is the one to bring forward.
      const focusedWindow = yield* electronWindow.focusedApp;
      const existingWindow = Option.isSome(focusedWindow)
        ? focusedWindow
        : yield* currentMainWindow;
      if (Option.isSome(existingWindow) && !pendingMainReveals.has(existingWindow.value)) {
        yield* electronWindow.prepareReveal(existingWindow.value);
      }
    }),
    activate: Effect.gen(function* () {
      if (yield* Ref.get(desktopState.quitting)) return;
      const existingWindow = yield* currentMainWindow;
      if (Option.isSome(existingWindow)) {
        yield* revealMain(existingWindow.value);
        return;
      }
      if (mainClosedDuringStartup) {
        yield* ensureMain;
        return;
      }
      const backendReady = yield* Ref.get(backendReadyRef);
      if (!backendReady) {
        const splash = yield* Ref.get(splashWindowRef);
        if (Option.isSome(splash)) {
          yield* electronWindow.reveal(splash.value);
          return;
        }
      }
      yield* createMainIfBackendReady;
    }).pipe(Effect.withSpan("desktop.window.activate")),
    createMainIfBackendReady,
    showConnectingSplash,
    handleBackendReady: Effect.fn("desktop.window.handleBackendReady")(function* (httpBaseUrl) {
      backendHasStarted = true;
      yield* Ref.set(backendReadyRef, true);
      yield* logWindowInfo("backend ready", { source: "http", url: httpBaseUrl.href });
      if (!mainClosedDuringStartup) yield* createMainIfBackendReady;
    }),
    handleBackendNotReady: Ref.set(backendReadyRef, false).pipe(
      Effect.withSpan("desktop.window.handleBackendNotReady"),
    ),
    flushMainWindowBounds: Effect.suspend(() => flushMainWindowBounds).pipe(
      Effect.withSpan("desktop.window.flushMainWindowBounds"),
    ),
    dispatchMenuAction: Effect.fn("desktop.window.dispatchMenuAction")(function* (action, options) {
      yield* Effect.annotateCurrentSpan({ action });
      yield* dispatchRendererEvent(MENU_ACTION_CHANNEL, action, options);
    }),
    dispatchSnapShotEvent: Effect.fn("desktop.window.dispatchSnapShotEvent")(function* (event) {
      yield* Effect.annotateCurrentSpan({
        event: event.type,
        captureId: "id" in event ? (event.id ?? null) : null,
      });
      if (event.type === "shortcut-changed") {
        for (const entry of entries.values()) {
          if (!entry.window.isDestroyed())
            entry.window.webContents.send(SNAP_SHOT_EVENT_CHANNEL, event);
        }
        return;
      }
      const id = event.id;
      const started = id === undefined ? undefined : captureWindows.get(id);
      const delivered = yield* dispatchRendererEvent(SNAP_SHOT_EVENT_CHANNEL, event, {
        reveal: event.type === "started",
        ...(started === undefined ? {} : { target: started }),
      });
      if (id === undefined) return;
      if (event.type === "ready" || event.type === "failed") captureWindows.delete(id);
      else if (Option.isSome(delivered)) captureWindows.set(id, delivered.value);
    }),
    zoomFocused: Effect.fn("desktop.window.zoomFocused")(function* (direction) {
      yield* Effect.annotateCurrentSpan({ direction });
      const window = yield* electronWindow.focusedApp;
      if (Option.isNone(window) || window.value.isDestroyed()) {
        return;
      }
      yield* zoomWindow(window.value, direction);
    }),
    runMainContentsCommand: Effect.fn("desktop.window.runMainContentsCommand")(function* (command) {
      yield* Effect.annotateCurrentSpan({ command });
      const window = yield* electronWindow.main;
      if (Option.isSome(window)) runContentsCommand(window.value, command);
    }),
    runFocusedContentsCommand: Effect.fn("desktop.window.runFocusedContentsCommand")(
      function* (command) {
        yield* Effect.annotateCurrentSpan({ command });
        // A focused OAuth popup must not receive the app's Reload command.
        const window = yield* electronWindow.focusedApp;
        if (Option.isSome(window)) runContentsCommand(window.value, command);
      },
    ),
    syncAppearance: Effect.gen(function* () {
      const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
      yield* electronWindow.syncAllAppearance((window, { titleBarOverlay }) =>
        syncWindowAppearance(window, titleBarOverlay, shouldUseDarkColors, environment.platform),
      );
    }).pipe(Effect.withSpan("desktop.window.syncAppearance")),
    windowsState: computeWindowsState,
    windowContext: Effect.fn("desktop.window.windowContext")(function (window) {
      return Effect.sync(() => {
        const entry = entryOf(window);
        if (entry === undefined) return Option.none<DesktopWindowContext>();
        return Option.some({
          windowId: entry.windowId,
          isMain: entry.isMain,
          ...(entry.isBot ? { bot: botState } : {}),
        });
      });
    }),
    openNewWindow: openSecondary,
    openBot,
    setBotSize: Effect.fn("desktop.window.setBotSize")(function* (window, size) {
      yield* Effect.annotateCurrentSpan({ size });
      if (entryOf(window)?.isBot !== true) return;
      botState = { ...botState, size };
      if (window.isMinimized()) window.restore();
      window.setBounds(
        resizeWithinDisplay({
          bounds: window.getBounds(),
          size: DesktopAppSettings.BOT_WINDOW_SIZES[size],
          displays: readDisplayWorkAreasOrEmpty(),
        }),
      );
      yield* persistBotWindow({ size });
    }),
    setBotPinned: Effect.fn("desktop.window.setBotPinned")(function* (window, pinned) {
      yield* Effect.annotateCurrentSpan({ pinned });
      if (entryOf(window)?.isBot !== true) return;
      botState = { ...botState, pinned };
      applyBotPinned(window, pinned);
      yield* persistBotWindow({ pinned });
    }),
    registerHub: Effect.fn("desktop.window.registerHub")(function (window) {
      return Effect.sync(() => {
        const entry = entryOf(window);
        if (entry !== undefined && entry.isMain) hubLinks.registerHub(hubPeer(entry));
      });
    }),
    requestHubLink: Effect.fn("desktop.window.requestHubLink")(function (window) {
      return Effect.sync(() => {
        const entry = entryOf(window);
        if (entry !== undefined && !entry.isMain) hubLinks.request(hubPeer(entry));
      });
    }),
  });
});

export const layer = Layer.effect(DesktopWindow, make);
