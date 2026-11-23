import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type {
  DesktopUpdateCheckResult,
  DesktopUpdateState,
  DesktopWindowsState,
} from "@t3tools/contracts";
import * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({
  webContents: { getAllWebContents: vi.fn(() => []) },
}));

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopApplicationMenu from "./DesktopApplicationMenu.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import { createInitialDesktopUpdateState } from "../updates/updateMachine.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "linux",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const layerElectronApp = Layer.succeed(ElectronApp.ElectronApp, {
  metadata: Effect.die("unexpected metadata read"),
  name: Effect.succeed("T3 Code"),
  systemLocale: Effect.succeed("en-US"),
  preferredSystemLanguages: Effect.succeed(["en-US"]),
  whenReady: Effect.void,
  requestSingleInstanceLock: Effect.succeed(true),
  quit: Effect.void,
  exit: () => Effect.void,
  relaunch: () => Effect.void,
  setPath: () => Effect.void,
  setName: () => Effect.void,
  setAboutPanelOptions: () => Effect.void,
  setAppUserModelId: () => Effect.void,
  getAppMetrics: Effect.succeed([]),
  setAsDefaultProtocolClient: () => Effect.succeed(true),
  setDesktopName: () => Effect.void,
  setDockIcon: () => Effect.void,
  appendCommandLineSwitch: () => Effect.void,
  onBeforeQuitForUpdate: () => Effect.void,
  removeCommandLineSwitch: () => Effect.void,
  on: () => Effect.void,
} satisfies ElectronApp.ElectronApp["Service"]);

interface MenuServices {
  readonly checkResult?: DesktopUpdateCheckResult;
  readonly shownMessageBox?: Deferred.Deferred<Electron.MessageBoxOptions>;
}

const layerElectronDialog = ({ shownMessageBox }: MenuServices) =>
  Layer.succeed(ElectronDialog.ElectronDialog, {
    pickFolder: () => Effect.succeedNone,
    pickFiles: () => Effect.succeed([]),
    showMessageBox: (options) =>
      (shownMessageBox ? Deferred.succeed(shownMessageBox, options) : Effect.void).pipe(
        Effect.as({ response: options.cancelId ?? 0, checkboxChecked: false }),
      ),
    showErrorBox: () => Effect.void,
  } satisfies ElectronDialog.ElectronDialog["Service"]);

const layerDesktopUpdates = ({ checkResult }: MenuServices) =>
  Layer.succeed(DesktopUpdates.DesktopUpdates, {
    getState: Effect.die("unexpected getState"),
    isActionActive: Effect.succeed(false),
    isInstallActive: Effect.succeed(false),
    subscribe: Effect.die("unexpected subscribe"),
    emitState: Effect.void,
    disabledReason: Effect.succeedNone,
    configure: Effect.void,
    setChannel: () => Effect.die("unexpected setChannel"),
    check: () => (checkResult ? Effect.succeed(checkResult) : Effect.die("unexpected check")),
    download: Effect.die("unexpected download"),
    install: Effect.die("unexpected install"),
    installPrepared: () => Effect.die("unexpected installPrepared"),
  } satisfies DesktopUpdates.DesktopUpdates["Service"]);

const emptyWindowsState: DesktopWindowsState = {
  profiles: [],
  windows: [],
  miniMode: false,
  multiWindowEnabled: true,
};

const windowProfile = (id: string, name: string) => ({
  id,
  name,
  projectScopeKeys: [],
  theme: null,
  isDefault: id === "main",
});

const openWindow = (windowId: number, profileId: string) => ({
  windowId,
  isMain: profileId === "main",
  profileId,
  name: profileId,
  title: "",
  focused: false,
  projectScopeKeys: [],
});

const layerDesktopWindow = (
  selectedAction: Deferred.Deferred<string>,
  windowsState: DesktopWindowsState = emptyWindowsState,
) =>
  Layer.mock(DesktopWindow.DesktopWindow)({
    createMain: Effect.die("unexpected createMain"),
    ensureMain: Effect.die("unexpected ensureMain"),
    revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
    activate: Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushWindowState: Effect.void,
    prepareCaptureReveal: Effect.void,
    dispatchMenuAction: (action) => Deferred.succeed(selectedAction, action).pipe(Effect.asVoid),
    dispatchSnapShotEvent: () => Effect.void,
    zoomFocused: (direction) =>
      Deferred.succeed(selectedAction, `zoom-${direction}`).pipe(Effect.asVoid),
    runFocusedContentsCommand: (command) =>
      Deferred.succeed(selectedAction, `main-${command}`).pipe(Effect.asVoid),
    syncAppearance: Effect.void,
    windowsState: Effect.succeed(windowsState),
    subscribeWindowsState: () => Effect.void,
    openProfile: (profileId) =>
      Deferred.succeed(selectedAction, `open-${profileId}`).pipe(Effect.asVoid),
  });

const layerElectronMenu = (
  applicationMenuTemplate: Deferred.Deferred<readonly Electron.MenuItemConstructorOptions[]>,
) =>
  Layer.succeed(ElectronMenu.ElectronMenu, {
    setApplicationMenu: (template) =>
      Deferred.succeed(applicationMenuTemplate, template).pipe(Effect.asVoid),
    popupTemplate: () => Effect.void,
    showContextMenu: () => Effect.succeedNone,
  } satisfies ElectronMenu.ElectronMenu["Service"]);

const configureMenu = (
  selectedAction: Deferred.Deferred<string>,
  applicationMenuTemplate: Deferred.Deferred<readonly Electron.MenuItemConstructorOptions[]>,
  environment: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  services: MenuServices = {},
  windowsState?: DesktopWindowsState,
) =>
  Effect.gen(function* () {
    const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
    yield* menu.configure;
  }).pipe(
    Effect.provide(
      DesktopApplicationMenu.layer.pipe(
        Layer.provideMerge(layerElectronMenu(applicationMenuTemplate)),
        Layer.provideMerge(layerDesktopWindow(selectedAction, windowsState)),
        Layer.provideMerge(layerDesktopUpdates(services)),
        Layer.provideMerge(layerElectronDialog(services)),
        Layer.provideMerge(layerElectronApp),
        Layer.provideMerge(
          DesktopEnvironment.layer({ ...environmentInput, ...environment }).pipe(
            Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
          ),
        ),
      ),
    ),
  );

const checkForUpdatesFromMacMenu = (state: Partial<DesktopUpdateState>) =>
  Effect.gen(function* () {
    const applicationMenuTemplate =
      yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
    const shownMessageBox = yield* Deferred.make<Electron.MessageBoxOptions>();
    yield* configureMenu(
      yield* Deferred.make<string>(),
      applicationMenuTemplate,
      { platform: "darwin" },
      {
        checkResult: {
          checked: true,
          state: {
            ...createInitialDesktopUpdateState(
              "0.1.5",
              { hostArch: "arm64", appArch: "arm64", runningUnderArm64Translation: false },
              "latest",
            ),
            enabled: true,
            ...state,
          },
        },
        shownMessageBox,
      },
    );

    const appMenu = (yield* Deferred.await(applicationMenuTemplate))[0];
    if (!Array.isArray(appMenu?.submenu)) {
      throw new Error("Expected the macOS app menu submenu to be an array.");
    }
    const checkForUpdates = appMenu.submenu.find((item) => item.label === "Check for Updates...");
    if (typeof checkForUpdates?.click !== "function") {
      throw new Error("Expected Check for Updates... menu item to have a click handler.");
    }

    // Every stub completes synchronously, so the menu action has finished when click returns.
    checkForUpdates.click(
      {} as Electron.MenuItem,
      {} as Electron.BrowserWindow,
      {} as KeyboardEvent,
    );
    const dialog = yield* Deferred.poll(shownMessageBox);
    if (Option.isNone(dialog)) {
      throw new Error("Check for Updates... finished without showing any dialog.");
    }
    return yield* dialog.value;
  });

describe("DesktopApplicationMenu", () => {
  it.effect("leaves the accelerator to Chromium instead of injecting a paste", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedAction, applicationMenuTemplate);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const editMenu = template.find((item) => item.label === "Edit");
      if (!Array.isArray(editMenu?.submenu)) {
        throw new Error("Expected Edit menu submenu to be an array.");
      }
      const pasteAsTextItem = editMenu.submenu.find((item) => item.label === "Paste as Text");
      if (typeof pasteAsTextItem?.click !== "function") {
        throw new Error("Expected Paste as Text menu item to have a click handler.");
      }

      pasteAsTextItem.click(
        {} as Electron.MenuItem,
        {} as Electron.BrowserWindow,
        {
          triggeredByAccelerator: true,
        } as unknown as KeyboardEvent,
      );
      assert.isFalse(yield* Deferred.isDone(selectedAction));
    }),
  );

  it.effect("registers macOS command-plus once and routes it through main-window zoom", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedAction, applicationMenuTemplate, { platform: "darwin" });

      const template = yield* Deferred.await(applicationMenuTemplate);
      const viewMenu = template.find((item) => item.label === "View");
      assert.isDefined(viewMenu);
      if (!Array.isArray(viewMenu.submenu)) {
        throw new Error("Expected View menu submenu to be an array.");
      }

      assert.isUndefined(
        viewMenu.submenu.find((item) =>
          ["zoom", "reload", "devtools"].some((role) => item.role?.toLowerCase().includes(role)),
        ),
      );

      const shiftedEqual = viewMenu.submenu.filter(
        (item) => item.accelerator === "CmdOrCtrl+Shift+=",
      );
      assert.lengthOf(shiftedEqual, 1);
      assert.lengthOf(
        viewMenu.submenu.filter((item) => item.accelerator === "CmdOrCtrl+numadd"),
        1,
      );
      const zoomIn = shiftedEqual[0];
      assert.isDefined(zoomIn);
      assert.isFalse(zoomIn.visible);
      if (typeof zoomIn.click !== "function") {
        throw new Error("Expected Zoom In menu item to have a click handler.");
      }

      zoomIn.click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.equal(yield* Deferred.await(selectedAction), "zoom-in");
    }),
  );

  it.effect("never binds Cmd/Ctrl+W to closing the window", () =>
    Effect.gen(function* () {
      for (const platform of ["darwin", "linux", "win32"] as const) {
        const applicationMenuTemplate =
          yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
        yield* configureMenu(yield* Deferred.make<string>(), applicationMenuTemplate, {
          platform,
        });

        const items: Electron.MenuItemConstructorOptions[] = [];
        const collect = (template: readonly Electron.MenuItemConstructorOptions[]) => {
          for (const item of template) {
            items.push(item);
            if (Array.isArray(item.submenu)) collect(item.submenu);
          }
        };
        collect(yield* Deferred.await(applicationMenuTemplate));

        assert.isUndefined(
          items.find((item) => item.role === "close"),
          platform,
        );
        // Electron's default windowMenu submenu includes a close role.
        assert.isUndefined(
          items.find((item) => item.role === "windowMenu" && item.submenu === undefined),
          platform,
        );
        const closeTools = items.find((item) => item.accelerator === "CmdOrCtrl+W");
        assert.equal(closeTools?.label, "Close Developer Tools", platform);
        assert.isFunction(closeTools?.click);
        const appContents = {
          isDestroyed: () => false,
          isDevToolsFocused: () => false,
          closeDevTools: vi.fn(),
        };
        const inspectedContents = {
          ...appContents,
          isDevToolsFocused: () => true,
          closeDevTools: vi.fn(),
        };
        using allContents = vi
          .spyOn(Electron.webContents, "getAllWebContents")
          .mockReturnValue([
            appContents as unknown as Electron.WebContents,
            inspectedContents as unknown as Electron.WebContents,
          ]);
        closeTools?.click?.({} as Electron.MenuItem, undefined, {} as KeyboardEvent);
        assert.equal(inspectedContents.closeDevTools.mock.calls.length, 1);
        assert.equal(appContents.closeDevTools.mock.calls.length, 0);

        allContents.mockReturnValue([appContents as unknown as Electron.WebContents]);
        closeTools?.click?.({} as Electron.MenuItem, undefined, {} as KeyboardEvent);
        assert.equal(appContents.closeDevTools.mock.calls.length, 0);
      }
    }),
  );

  it.effect("reloads the main window even while a browser page has focus", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedAction, applicationMenuTemplate);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const viewMenu = template.find((item) => item.label === "View");
      if (!Array.isArray(viewMenu?.submenu)) {
        throw new Error("Expected View menu submenu to be an array.");
      }
      const reload = viewMenu.submenu.find((item) => item.label === "Reload");
      assert.equal(reload?.accelerator, "CmdOrCtrl+R");
      if (typeof reload?.click !== "function") {
        throw new Error("Expected Reload menu item to have a click handler.");
      }

      reload.click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.equal(yield* Deferred.await(selectedAction), "main-reload");
    }),
  );
  it.effect("lists saved windows, marks open ones, and leaves New Window to the renderer", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
      yield* configureMenu(
        selectedAction,
        applicationMenuTemplate,
        {},
        {},
        {
          profiles: [
            windowProfile("main", "Main"),
            windowProfile("work", "Work"),
            windowProfile("side", "Side"),
          ],
          windows: [openWindow(1, "main"), openWindow(2, "work")],
          miniMode: true,
          multiWindowEnabled: true,
        },
      );

      const windowMenu = (yield* Deferred.await(applicationMenuTemplate)).find(
        (item) => item.role === "windowMenu",
      );
      if (!Array.isArray(windowMenu?.submenu)) {
        throw new Error("Expected the Window menu submenu to be an array.");
      }
      const items = windowMenu.submenu.filter((item) => item.label !== undefined);
      assert.deepEqual(
        items.slice(0, 5).map(({ label, checked }) => ({ label, checked })),
        [
          { label: "New Window", checked: undefined },
          { label: "Main Window", checked: undefined },
          { label: "Work", checked: true },
          { label: "Side", checked: false },
          { label: "Mini Mode", checked: true },
        ],
      );
      assert.deepEqual(
        { accelerator: items[0]?.accelerator, registerAccelerator: items[0]?.registerAccelerator },
        { accelerator: "CmdOrCtrl+Alt+Shift+N", registerAccelerator: false },
      );
      items[0]?.click?.({} as Electron.MenuItem, undefined, {} as KeyboardEvent);
      assert.equal(yield* Deferred.await(selectedAction), "new-window");
    }),
  );

  it.effect(
    "drops New Window and saved windows from the Window menu when multi-window is off",
    () =>
      Effect.gen(function* () {
        const applicationMenuTemplate =
          yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
        yield* configureMenu(
          yield* Deferred.make<string>(),
          applicationMenuTemplate,
          {},
          {},
          {
            ...emptyWindowsState,
            profiles: [windowProfile("main", "Main"), windowProfile("work", "Work")],
            multiWindowEnabled: false,
          },
        );

        const windowMenu = (yield* Deferred.await(applicationMenuTemplate)).find(
          (item) => item.role === "windowMenu",
        );
        if (!Array.isArray(windowMenu?.submenu)) {
          throw new Error("Expected the Window menu submenu to be an array.");
        }
        assert.deepEqual(
          windowMenu.submenu.flatMap((item) => (item.label === undefined ? [] : [item.label])),
          // The role items carry translated labels too.
          ["Mini Mode", "Minimize", "Zoom"],
        );
      }),
  );

  it.effect("tells the user which update the menu check found", () =>
    Effect.gen(function* () {
      const dialog = yield* checkForUpdatesFromMacMenu({
        status: "available",
        availableVersion: "0.1.7",
      });
      assert.include(`${dialog.title ?? ""} ${dialog.message} ${dialog.detail ?? ""}`, "0.1.7");
    }),
  );

  it.effect("tells the user a downloaded update is ready when the menu check runs", () =>
    Effect.gen(function* () {
      const dialog = yield* checkForUpdatesFromMacMenu({
        status: "downloaded",
        availableVersion: "0.1.7",
        downloadedVersion: "0.1.7",
        downloadPercent: 100,
      });
      assert.include(`${dialog.title ?? ""} ${dialog.message} ${dialog.detail ?? ""}`, "0.1.7");
    }),
  );

  it.effect("labels every role item so the menu follows the UI language", () =>
    Effect.gen(function* () {
      // Electron's role defaults are English on every platform, so each role item needs a label.
      for (const platform of ["darwin", "linux", "win32"] as const) {
        const applicationMenuTemplate =
          yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
        yield* configureMenu(yield* Deferred.make<string>(), applicationMenuTemplate, {
          platform,
        });

        const unlabeled: string[] = [];
        const collect = (template: readonly Electron.MenuItemConstructorOptions[]) => {
          for (const item of template) {
            if (item.role !== undefined && typeof item.label !== "string") {
              unlabeled.push(item.role);
            }
            if (Array.isArray(item.submenu)) collect(item.submenu);
          }
        };
        collect(yield* Deferred.await(applicationMenuTemplate));
        assert.deepStrictEqual(unlabeled, [], platform);
      }
    }),
  );
});
