import { DesktopWindowContextSchema, DesktopWindowsStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getContext = DesktopIpc.makeSyncIpcMethod({
  channel: IpcChannels.WINDOWS_GET_CONTEXT_CHANNEL,
  result: Schema.NullOr(DesktopWindowContextSchema),
  handler: Effect.fn("desktop.ipc.windows.getContext")(function* () {
    const { window } = yield* DesktopIpc.DesktopIpcSender;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    return Option.getOrNull(yield* desktopWindow.windowContext(window));
  }),
});

const getState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopWindowsStateSchema,
  handler: Effect.fn("desktop.ipc.windows.getState")(function* () {
    return yield* (yield* DesktopWindow.DesktopWindow).windowsState;
  }),
});

const openNew = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_OPEN_NEW_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windows.openNew")(function* () {
    yield* (yield* DesktopWindow.DesktopWindow).openNewWindow;
  }),
});

const registerHub = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_REGISTER_HUB_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windows.registerHub")(function* () {
    const { window } = yield* DesktopIpc.DesktopIpcSender;
    yield* (yield* DesktopWindow.DesktopWindow).registerHub(window);
  }),
});

const requestHubLink = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_REQUEST_HUB_LINK_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windows.requestHubLink")(function* () {
    const { window } = yield* DesktopIpc.DesktopIpcSender;
    yield* (yield* DesktopWindow.DesktopWindow).requestHubLink(window);
  }),
});

export const methods = [getState, openNew, registerHub, requestHubLink] as const;
