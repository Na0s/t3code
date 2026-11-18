import {
  DesktopCreateWindowProfileInputSchema,
  DesktopOpenWindowInputSchema,
  DesktopResolveWindowCloseInputSchema,
  DesktopUpdateWindowProfileInputSchema,
  DesktopWindowProfileIdSchema,
  DesktopWindowProfileNameSchema,
  DesktopWindowProfileSchema,
  DesktopWindowProjectScopeKeysSchema,
  DesktopWindowsStateSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const DesktopWindowContextSchema = Schema.Struct({
  windowId: Schema.Int,
  isMain: Schema.Boolean,
  profileId: Schema.NullOr(Schema.String),
  projectScopeKeys: Schema.Array(Schema.String),
  theme: Schema.NullOr(Schema.String),
});

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
  payload: Schema.UndefinedOr(DesktopOpenWindowInputSchema),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windows.openNew")(function* (input) {
    yield* (yield* DesktopWindow.DesktopWindow).openNewWindow(input ?? {});
  }),
});

const openProfile = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_OPEN_PROFILE_CHANNEL,
  payload: DesktopWindowProfileIdSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windows.openProfile")(function* (profileId) {
    yield* (yield* DesktopWindow.DesktopWindow).openProfile(profileId);
  }),
});

const focus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_FOCUS_CHANNEL,
  payload: Schema.Int,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windows.focus")(function* (windowId) {
    yield* (yield* DesktopWindow.DesktopWindow).focusWindow(windowId);
  }),
});

const createProfile = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_CREATE_PROFILE_CHANNEL,
  payload: DesktopCreateWindowProfileInputSchema,
  result: DesktopWindowProfileSchema,
  handler: Effect.fn("desktop.ipc.windows.createProfile")(function* (input) {
    return yield* (yield* DesktopWindow.DesktopWindow).createProfile(input);
  }),
});

const saveAsProfile = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_SAVE_AS_PROFILE_CHANNEL,
  payload: DesktopWindowProfileNameSchema,
  result: DesktopWindowProfileSchema,
  handler: Effect.fn("desktop.ipc.windows.saveAsProfile")(function* (name) {
    const { window } = yield* DesktopIpc.DesktopIpcSender;
    return yield* (yield* DesktopWindow.DesktopWindow).saveWindowAsProfile(window, name);
  }),
});

const updateProfile = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_UPDATE_PROFILE_CHANNEL,
  payload: DesktopUpdateWindowProfileInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windows.updateProfile")(function* (input) {
    yield* (yield* DesktopWindow.DesktopWindow).updateProfile(input);
  }),
});

const deleteProfile = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_DELETE_PROFILE_CHANNEL,
  payload: DesktopWindowProfileIdSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windows.deleteProfile")(function* (profileId) {
    yield* (yield* DesktopWindow.DesktopWindow).deleteProfile(profileId);
  }),
});

const setProjectScopeKeys = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_SET_PROJECT_SCOPE_KEYS_CHANNEL,
  payload: DesktopWindowProjectScopeKeysSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windows.setProjectScopeKeys")(function* (projectScopeKeys) {
    const { window } = yield* DesktopIpc.DesktopIpcSender;
    yield* (yield* DesktopWindow.DesktopWindow).setWindowProjectScopeKeys(window, projectScopeKeys);
  }),
});

const setCloseRequestListening = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_CLOSE_REQUEST_LISTENING_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windows.setCloseRequestListening")(function* (listening) {
    const { window } = yield* DesktopIpc.DesktopIpcSender;
    yield* (yield* DesktopWindow.DesktopWindow).setCloseRequestListening(window, listening);
  }),
});

const resolveCloseRequest = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_RESOLVE_CLOSE_REQUEST_CHANNEL,
  payload: DesktopResolveWindowCloseInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windows.resolveCloseRequest")(function* ({
    requestId,
    decision,
  }) {
    const { window } = yield* DesktopIpc.DesktopIpcSender;
    yield* (yield* DesktopWindow.DesktopWindow).resolveCloseRequest(window, requestId, decision);
  }),
});

const setMiniMode = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_SET_MINI_MODE_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windows.setMiniMode")(function* (enabled) {
    yield* (yield* DesktopWindow.DesktopWindow).setMiniMode(enabled);
  }),
});

const setMultiWindowEnabled = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_SET_MULTI_WINDOW_ENABLED_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windows.setMultiWindowEnabled")(function* (enabled) {
    yield* (yield* DesktopWindow.DesktopWindow).setMultiWindowEnabled(enabled);
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

export const methods = [
  getState,
  openNew,
  openProfile,
  focus,
  createProfile,
  saveAsProfile,
  updateProfile,
  deleteProfile,
  setProjectScopeKeys,
  setCloseRequestListening,
  resolveCloseRequest,
  setMiniMode,
  setMultiWindowEnabled,
  registerHub,
  requestHubLink,
] as const;
