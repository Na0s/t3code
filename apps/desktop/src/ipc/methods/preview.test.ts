import { it as effectIt } from "@effect/vitest";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  PreviewCaptureFailure,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as PreviewManager from "../../preview/Manager.ts";
import * as PreviewIpc from "./preview.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as IpcChannels from "../channels.ts";

const { fromPartition } = vi.hoisted(() => ({
  fromPartition: vi.fn(() => {
    throw new Error("Session can only be received when app is ready");
  }),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  session: {
    fromPartition,
  },
  webContents: {
    fromId: vi.fn(() => null),
  },
}));

const decodeCaptureFailure = Schema.decodeUnknownEffect(PreviewCaptureFailure);

describe("preview IPC methods", () => {
  const invokeCapture = (
    method: typeof PreviewIpc.startRecording | typeof PreviewIpc.captureScreenshot,
    manager: Partial<PreviewManager.PreviewManager["Service"]>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        let listener: DesktopIpc.DesktopIpcHandleListener | undefined;
        const ipc = DesktopIpc.make(
          {
            removeHandler: vi.fn(),
            handle: (_channel, registered) => {
              listener = registered;
            },
            removeAllListeners: vi.fn(),
            on: vi.fn(),
          },
          () => Effect.succeedSome({ window: {} as Electron.BrowserWindow, isMain: true }),
        );
        yield* ipc.handle(method);
        return yield* Effect.promise(async () =>
          structuredClone(await listener!({ sender: { id: 7 } }, { tabId: "capture-tab" })),
        );
      }).pipe(
        Effect.provideService(
          PreviewManager.PreviewManager,
          manager as PreviewManager.PreviewManager["Service"],
        ),
        Effect.provideService(DesktopClientSettings.DesktopClientSettings, {
          get: Effect.succeedNone,
          set: () => Effect.void,
        }),
      ),
    );

  effectIt.effect.each([
    {
      cause: new Error("Current display surface not available for capture"),
      reason: "capture-unavailable",
      guidance: ["target tab", "unlocked", "display is on", "window is restored"],
    },
    {
      cause: new Cause.TimeoutError(),
      reason: "capture-timeout",
      guidance: ["timed out during capture-page"],
    },
    {
      cause: new Error("Current display surface not available for capture: private page data"),
      reason: "capture-failed",
      guidance: ["Preview capture failed during capture-page"],
    },
  ])(
    "transports a safe $reason screenshot diagnostic through registered IPC",
    ({ cause, reason, guidance }) =>
      Effect.gen(function* () {
        const result = yield* invokeCapture(PreviewIpc.captureScreenshot, {
          captureScreenshot: (tabId) =>
            Effect.fail(
              new PreviewManager.PreviewOperationError({
                operation: "captureScreenshot.capturePage",
                tabId,
                artifactPath: "/private/capture.png",
                cause,
              }),
            ),
        });
        expect(result).toEqual({
          _tag: "PreviewCaptureFailure",
          reason,
          stage: "capture-page",
        });
        const failure = yield* decodeCaptureFailure(result);
        for (const phrase of guidance) expect(failure.message).toContain(phrase);
      }),
  );

  effectIt.effect(
    "scopes a secondary window's tabs and sends their events only to it, unscoped",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const appWindow = (id: number) =>
            ({
              id,
              isDestroyed: () => false,
              webContents: { send: vi.fn() },
            }) as unknown as Electron.BrowserWindow;
          const main = appWindow(1);
          const secondary = appWindow(3);
          const created: unknown[] = [];
          let emitState:
            | Parameters<PreviewManager.PreviewManager["Service"]["subscribeStateChanges"]>[0]
            | undefined;
          const manager = {
            createTab: (tabId, _defaults, owner) =>
              Effect.sync(() => {
                created.push({ tabId, owner });
                return {} as never;
              }),
            tabRoute: (tabId) =>
              Effect.succeed(
                tabId === "w3:tab"
                  ? { window: Option.some(secondary), rendererTabId: "tab" }
                  : { window: Option.some(main), rendererTabId: tabId },
              ),
            subscribeStateChanges: (listener) =>
              Effect.sync(() => {
                emitState = listener;
              }),
            subscribeRecordingInputs: () => Effect.void,
            subscribePointerEvents: () => Effect.void,
            subscribeOpenLinks: () => Effect.void,
            subscribeFindResults: () => Effect.void,
          } satisfies Partial<PreviewManager.PreviewManager["Service"]>;
          let listener: DesktopIpc.DesktopIpcHandleListener | undefined;
          const ipc = DesktopIpc.make(
            {
              removeHandler: vi.fn(),
              handle: (_channel, registered) => {
                listener = registered;
              },
              removeAllListeners: vi.fn(),
              on: vi.fn(),
            },
            () => Effect.succeedSome({ window: secondary, isMain: false }),
          );
          yield* Effect.gen(function* () {
            yield* ipc.handle(PreviewIpc.createTab);
            yield* PreviewIpc.installPreviewEventForwarding();
            yield* Effect.promise(async () => listener!({ sender: { id: 3 } }, { tabId: "tab" }));
            yield* emitState!("w3:tab", { tabId: "w3:tab" } as never);
          }).pipe(
            Effect.provideService(
              PreviewManager.PreviewManager,
              manager as unknown as PreviewManager.PreviewManager["Service"],
            ),
          );

          expect(created).toEqual([
            { tabId: "w3:tab", owner: { window: secondary, rendererTabId: "tab" } },
          ]);
          expect(vi.mocked(secondary.webContents.send).mock.calls).toEqual([
            [IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, "tab", { tabId: "tab" }],
          ]);
          expect(vi.mocked(main.webContents.send)).not.toHaveBeenCalled();
        }),
      ),
  );

  beforeEach(() => {
    fromPartition.mockClear();
  });

  it("derives distinct partition scopes when identifiers contain the delimiter", () => {
    const first = PreviewIpc.resolvePartitionScope("a", "b::c");
    const second = PreviewIpc.resolvePartitionScope("a::b", "c");

    expect(first).toEqual({ scope: '["a","b::c"]', persistent: true, namespace: "profile" });
    expect(second).toEqual({ scope: '["a::b","c"]', persistent: true, namespace: "profile" });
    expect(first.scope).not.toBe(second.scope);
  });

  it("keeps the legacy default partition scope and incognito persistence", () => {
    expect(PreviewIpc.resolvePartitionScope("environment::legacy", undefined)).toEqual({
      scope: "environment::legacy",
      persistent: true,
    });
    expect(
      PreviewIpc.resolvePartitionScope("environment::legacy", DEFAULT_BROWSER_PROFILE_ID),
    ).toEqual({ scope: "environment::legacy", persistent: true });
    expect(
      PreviewIpc.resolvePartitionScope("environment::legacy", INCOGNITO_BROWSER_PROFILE_ID),
    ).toEqual({
      scope: '["environment::legacy","incognito"]',
      persistent: false,
      namespace: "profile",
    });
  });
});
