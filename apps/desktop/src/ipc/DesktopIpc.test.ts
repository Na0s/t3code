import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "./DesktopIpc.ts";

it.effect("answers only app windows' top frames and tells handlers which window sent", () =>
  Effect.gen(function* () {
    const mainFrame = {};
    const secondaryFrame = {};
    const mainWindow = { id: 10, webContents: { id: 1, mainFrame } };
    const secondaryWindow = { id: 11, webContents: { id: 3, mainFrame: secondaryFrame } };
    const invoke = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    const sync = new Map<string, DesktopIpc.DesktopIpcSyncListener>();
    const ipc = yield* DesktopIpc.DesktopIpc.pipe(
      Effect.provide(
        DesktopIpc.layer({
          removeHandler: (channel) => void invoke.delete(channel),
          handle: (channel, listener) => void invoke.set(channel, listener),
          removeAllListeners: (channel) => void sync.delete(channel),
          on: (channel, listener) => void sync.set(channel, listener),
        }).pipe(
          Layer.provide(
            Layer.mock(ElectronWindow.ElectronWindow, {
              main: Effect.succeedSome(mainWindow as unknown as Electron.BrowserWindow),
              apps: Effect.succeed([
                mainWindow,
                secondaryWindow,
              ] as unknown as ReadonlyArray<Electron.BrowserWindow>),
            }),
          ),
        ),
      ),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: "token",
        payload: Schema.Void,
        result: Schema.String,
        handler: () =>
          Effect.map(
            DesktopIpc.DesktopIpcSender,
            ({ window, isMain }) => `secret-${window.id}${isMain ? "-main" : ""}`,
          ),
      }),
    );
    yield* ipc.handleSync({
      channel: "token-sync",
      handler: () => Effect.map(DesktopIpc.DesktopIpcSender, ({ window }) => `secret-${window.id}`),
    });

    const senders = {
      app: { sender: { id: 1 }, senderFrame: mainFrame },
      secondary: { sender: { id: 3 }, senderFrame: secondaryFrame },
      appSubframe: { sender: { id: 1 }, senderFrame: {} },
      previewGuest: { sender: { id: 2 }, senderFrame: {} },
    };
    const results: Record<string, unknown> = {};
    for (const [name, sender] of Object.entries(senders)) {
      const event = { ...sender, returnValue: "unset" as unknown };
      sync.get("token-sync")!(event);
      results[name] = [
        yield* Effect.promise(() =>
          Promise.resolve(invoke.get("token")!(sender, undefined)).catch(() => "rejected"),
        ),
        event.returnValue,
      ];
    }
    assert.deepEqual(results, {
      app: ["secret-10-main", "secret-10"],
      secondary: ["secret-11", "secret-11"],
      appSubframe: ["rejected", undefined],
      previewGuest: ["rejected", undefined],
    });
  }),
);
