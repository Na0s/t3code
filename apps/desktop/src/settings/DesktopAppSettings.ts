import {
  DEFAULT_DESKTOP_WINDOW_PROFILE_ID,
  DesktopServerExposureModeSchema,
  DesktopUpdateChannelSchema,
  DesktopWindowProfileIdSchema,
  DesktopWindowProfileNameSchema,
  DesktopWindowProfileThemeSchema,
  DesktopWindowProjectScopeKeysSchema,
  type DesktopServerExposureMode,
  type DesktopUpdateChannel,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  DEFAULT_LINUX_PASSWORD_STORE,
  normalizeLinuxPasswordStorePreference,
  type LinuxPasswordStorePreference,
} from "../linuxSecretStorage.ts";
import { desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import { isValidDistroName } from "../wsl/wslPathParsing.ts";

export interface DesktopSettings {
  readonly localEnvironmentEnabled: boolean;
  readonly linuxPasswordStore: LinuxPasswordStorePreference;
  /** The default (main window) profile is always first. */
  readonly windowProfiles: ReadonlyArray<DesktopWindowProfileSettings>;
  readonly serverExposureMode: DesktopServerExposureMode;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
  readonly updateChannel: DesktopUpdateChannel;
  readonly updateChannelConfiguredByUser: boolean;
  readonly wslBackendEnabled: boolean;
  readonly wslDistro: string | null;
  // Requires restart because the pool chooses its primary spec at layer initialization.
  readonly wslOnly: boolean;
}

export interface DesktopWindowProfileSettings {
  readonly id: string;
  readonly name: string;
  readonly projectScopeKeys: ReadonlyArray<string>;
  readonly theme: string | null;
  readonly bounds: DesktopWindowBounds | null;
  readonly maximized: boolean;
  /** Reopen this profile's window on the next launch; set for windows open when the app quit. */
  readonly openAtQuit: boolean;
}

export interface DesktopSettingsChange {
  readonly settings: DesktopSettings;
  readonly changed: boolean;
}

const DEFAULT_TAILSCALE_SERVE_PORT = 443;
// Fits half and third tiles of common scaled displays (down to 480x432 DIP) on
// Wayland, where Electron's client-side frame adds 32x42 DIP to the enforced
// minimum. The web layout already handles phone widths.
export const MIN_MAIN_WINDOW_SIZE = {
  width: 400,
  height: 360,
} as const;
export const DesktopWindowBoundsSchema = Schema.Struct({
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_MAIN_WINDOW_SIZE.width)),
  height: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_MAIN_WINDOW_SIZE.height)),
});
export type DesktopWindowBounds = typeof DesktopWindowBoundsSchema.Type;
export const DEFAULT_MAIN_WINDOW_SIZE = {
  width: 1100,
  height: 780,
} as const;

const DEFAULT_WINDOW_PROFILE_NAME = "Main";

export const DEFAULT_WINDOW_PROFILE: DesktopWindowProfileSettings = {
  id: DEFAULT_DESKTOP_WINDOW_PROFILE_ID,
  name: DEFAULT_WINDOW_PROFILE_NAME,
  projectScopeKeys: [],
  theme: null,
  bounds: null,
  maximized: false,
  openAtQuit: false,
};

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  localEnvironmentEnabled: true,
  linuxPasswordStore: DEFAULT_LINUX_PASSWORD_STORE,
  windowProfiles: [DEFAULT_WINDOW_PROFILE],
  serverExposureMode: "local-only",
  tailscaleServeEnabled: false,
  tailscaleServePort: DEFAULT_TAILSCALE_SERVE_PORT,
  updateChannel: "latest",
  updateChannelConfiguredByUser: false,
  wslBackendEnabled: false,
  wslDistro: null,
  wslOnly: false,
};

const DesktopWindowBoundsDocument = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});

// A value this build cannot read drops only its own key, so the rest of the file
// still loads and is written back instead of every setting resetting to defaults.
const optionalReadableKey = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(schema.pipe(Schema.catchDecoding(() => Effect.succeedNone)));

const DesktopWindowProfileDocument = Schema.Struct({
  id: optionalReadableKey(Schema.String),
  name: optionalReadableKey(Schema.String),
  projectScopeKeys: optionalReadableKey(Schema.Array(Schema.Unknown)),
  theme: optionalReadableKey(Schema.NullOr(Schema.String)),
  bounds: optionalReadableKey(Schema.NullOr(DesktopWindowBoundsDocument)),
  maximized: optionalReadableKey(Schema.Boolean),
  openAtQuit: optionalReadableKey(Schema.Boolean),
});
type DesktopWindowProfileDocument = typeof DesktopWindowProfileDocument.Type;

const DesktopSettingsDocument = Schema.Struct({
  localEnvironmentEnabled: optionalReadableKey(Schema.Boolean),
  linuxPasswordStore: optionalReadableKey(Schema.Unknown),
  // Mirrors the default profile's placement so an older build keeps the main window where it was.
  mainWindowBounds: optionalReadableKey(Schema.NullOr(DesktopWindowBoundsDocument)),
  mainWindowMaximized: optionalReadableKey(Schema.Boolean),
  windowProfiles: optionalReadableKey(Schema.Array(Schema.Unknown)),
  serverExposureMode: optionalReadableKey(DesktopServerExposureModeSchema),
  tailscaleServeEnabled: optionalReadableKey(Schema.Boolean),
  tailscaleServePort: optionalReadableKey(Schema.Number),
  updateChannel: optionalReadableKey(DesktopUpdateChannelSchema),
  updateChannelConfiguredByUser: optionalReadableKey(Schema.Boolean),
  wslBackendEnabled: optionalReadableKey(Schema.Boolean),
  wslMode: optionalReadableKey(Schema.Literals(["local", "wsl"])),
  wslDistro: optionalReadableKey(Schema.NullOr(Schema.String)),
  wslOnly: optionalReadableKey(Schema.Boolean),
});

type DesktopSettingsDocument = typeof DesktopSettingsDocument.Type;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const DesktopSettingsJson = fromLenientJson(DesktopSettingsDocument);
const decodeDesktopSettingsJson = Schema.decodeEffect(DesktopSettingsJson);
const encodeDesktopSettingsJson = Schema.encodeEffect(DesktopSettingsJson);
const decodeDesktopWindowBounds = Schema.decodeUnknownOption(DesktopWindowBoundsSchema);
const desktopWindowBoundsEquivalence = Schema.toEquivalence(DesktopWindowBoundsSchema);
const decodeWindowProfileDocument = Schema.decodeUnknownOption(DesktopWindowProfileDocument);
const isWindowProfileId = Schema.is(DesktopWindowProfileIdSchema);
const isWindowProfileName = Schema.is(DesktopWindowProfileNameSchema);
const isWindowProfileTheme = Schema.is(DesktopWindowProfileThemeSchema);
const isProjectScopeKeys = Schema.is(DesktopWindowProjectScopeKeysSchema);
const isProjectScopeKey = (key: unknown): key is string => isProjectScopeKeys([key]);
const MAX_PROJECT_SCOPE_KEYS = 1000;

const settingsChange = (settings: DesktopSettings, changed: boolean): DesktopSettingsChange => ({
  settings,
  changed,
});

const DesktopSettingsWriteOperation = Schema.Literals([
  "create-temporary-file-name",
  "resolve-symlink",
  "encode-document",
  "create-directory",
  "write-temporary-file",
  "replace-settings-file",
]);
type DesktopSettingsWriteOperation = typeof DesktopSettingsWriteOperation.Type;

export class DesktopSettingsWriteError extends Schema.TaggedError<DesktopSettingsWriteError>()(
  "DesktopSettingsWriteError",
  {
    operation: DesktopSettingsWriteOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop settings write failed during ${this.operation} at ${this.path}.`;
  }
}

export class DesktopAppSettings extends Context.Service<
  DesktopAppSettings,
  {
    readonly load: Effect.Effect<DesktopSettings>;
    readonly get: Effect.Effect<DesktopSettings>;
    readonly setLocalEnvironmentEnabled: (
      enabled: boolean,
    ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
    readonly setWindowProfilePlacement: (
      profileId: string,
      bounds: DesktopWindowBounds,
      isMaximized: boolean,
    ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
    /** The result is normalized: invalid and duplicate profiles drop, the default one stays. */
    readonly updateWindowProfiles: (
      update: (
        profiles: ReadonlyArray<DesktopWindowProfileSettings>,
      ) => ReadonlyArray<DesktopWindowProfileSettings>,
    ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
    readonly setServerExposureMode: (
      mode: DesktopServerExposureMode,
    ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
    readonly setTailscaleServe: (input: {
      readonly enabled: boolean;
      readonly port: Option.Option<number>;
    }) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
    readonly setUpdateChannel: (
      channel: DesktopUpdateChannel,
    ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
    readonly setWslBackendEnabled: (
      enabled: boolean,
    ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
    readonly setWslDistro: (
      distro: string | null,
    ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
    readonly setWslOnly: (
      enabled: boolean,
    ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
    readonly applyWslWindowsFallback: Effect.Effect<
      DesktopSettingsChange,
      DesktopSettingsWriteError
    >;
    readonly applyWslWindowsFallbackInMemory: Effect.Effect<DesktopSettingsChange>;
  }
>()("@t3tools/desktop/settings/DesktopAppSettings") {}

export function resolveDefaultDesktopSettings(appVersion: string): DesktopSettings {
  return {
    ...DEFAULT_DESKTOP_SETTINGS,
    updateChannel: desktopUpdateChannelOf(appVersion),
  };
}

function normalizeTailscaleServePort(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535
    ? value
    : DEFAULT_TAILSCALE_SERVE_PORT;
}

function normalizeWslDistro(value: unknown): string | null {
  return typeof value === "string" && isValidDistroName(value) ? value : null;
}

export function normalizeMainWindowBounds(value: unknown): DesktopWindowBounds | null {
  return Option.getOrNull(decodeDesktopWindowBounds(value));
}

export function normalizeProjectScopeKeys(value: ReadonlyArray<unknown>): ReadonlyArray<string> {
  const keys = new Set<string>();
  for (const key of value) {
    if (keys.size >= MAX_PROJECT_SCOPE_KEYS) break;
    if (isProjectScopeKey(key)) keys.add(key);
  }
  return [...keys];
}

function normalizeWindowProfile(
  document: DesktopWindowProfileDocument,
): DesktopWindowProfileSettings | null {
  const { id, name } = document;
  if (!isWindowProfileId(id)) return null;
  const isDefault = id === DEFAULT_DESKTOP_WINDOW_PROFILE_ID;
  const validName = isWindowProfileName(name) && name.trim() !== "" ? name : null;
  if (validName === null && !isDefault) return null;
  const bounds = normalizeMainWindowBounds(document.bounds);
  return {
    id,
    name: validName ?? DEFAULT_WINDOW_PROFILE_NAME,
    projectScopeKeys: isDefault ? [] : normalizeProjectScopeKeys(document.projectScopeKeys ?? []),
    theme: !isDefault && isWindowProfileTheme(document.theme) ? document.theme : null,
    bounds,
    maximized: bounds !== null && document.maximized === true,
    openAtQuit: !isDefault && document.openAtQuit === true,
  };
}

/**
 * Keeps valid profiles in order with unique ids and the default profile first. The default
 * profile cannot carry a theme, filter or reopen flag.
 */
export function normalizeWindowProfiles(
  profiles: ReadonlyArray<DesktopWindowProfileDocument>,
): ReadonlyArray<DesktopWindowProfileSettings> {
  const seen = new Set<string>();
  let defaultProfile: DesktopWindowProfileSettings = DEFAULT_WINDOW_PROFILE;
  const others: DesktopWindowProfileSettings[] = [];
  for (const candidate of profiles) {
    const profile = normalizeWindowProfile(candidate);
    if (profile === null || seen.has(profile.id)) continue;
    seen.add(profile.id);
    if (profile.id === DEFAULT_DESKTOP_WINDOW_PROFILE_ID) defaultProfile = profile;
    else others.push(profile);
  }
  return [defaultProfile, ...others];
}

function windowProfilesEqual(
  left: ReadonlyArray<DesktopWindowProfileSettings>,
  right: ReadonlyArray<DesktopWindowProfileSettings>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readWindowProfiles(parsed: DesktopSettingsDocument) {
  const documents: DesktopWindowProfileDocument[] = [];
  for (const entry of parsed.windowProfiles ?? []) {
    const decoded = decodeWindowProfileDocument(entry);
    if (Option.isSome(decoded)) documents.push(decoded.value);
  }
  const [defaultProfile = DEFAULT_WINDOW_PROFILE, ...others] = normalizeWindowProfiles(documents);
  // The default profile's placement lives in the legacy keys, which older builds also read and write.
  const bounds = normalizeMainWindowBounds(parsed.mainWindowBounds);
  return [
    {
      ...defaultProfile,
      bounds,
      maximized: bounds !== null && parsed.mainWindowMaximized === true,
    },
    ...others,
  ];
}

export function defaultWindowProfile(settings: DesktopSettings): DesktopWindowProfileSettings {
  return settings.windowProfiles[0] ?? DEFAULT_WINDOW_PROFILE;
}

function normalizeDesktopSettingsDocument(
  parsed: DesktopSettingsDocument,
  appVersion: string,
): DesktopSettings {
  const defaultSettings = resolveDefaultDesktopSettings(appVersion);
  const parsedUpdateChannel = Option.fromNullishOr(parsed.updateChannel);
  const isLegacySettings = parsed.updateChannelConfiguredByUser === undefined;
  const updateChannelConfiguredByUser =
    parsed.updateChannelConfiguredByUser === true ||
    (isLegacySettings && Option.contains(parsedUpdateChannel, "nightly"));

  const wslBackendEnabled =
    parsed.wslBackendEnabled === true ||
    (parsed.wslBackendEnabled === undefined && parsed.wslMode === "wsl");

  return {
    localEnvironmentEnabled: parsed.localEnvironmentEnabled !== false,
    linuxPasswordStore: normalizeLinuxPasswordStorePreference(parsed.linuxPasswordStore),
    windowProfiles: readWindowProfiles(parsed),
    serverExposureMode:
      parsed.serverExposureMode === "network-accessible" ? "network-accessible" : "local-only",
    tailscaleServeEnabled: parsed.tailscaleServeEnabled === true,
    tailscaleServePort: normalizeTailscaleServePort(parsed.tailscaleServePort),
    updateChannel: updateChannelConfiguredByUser
      ? Option.getOrElse(parsedUpdateChannel, () => defaultSettings.updateChannel)
      : defaultSettings.updateChannel,
    updateChannelConfiguredByUser,
    wslBackendEnabled,
    wslDistro: normalizeWslDistro(parsed.wslDistro),
    wslOnly: parsed.wslOnly === true,
  };
}

function toDesktopSettingsDocument(
  settings: DesktopSettings,
  defaults: DesktopSettings,
): DesktopSettingsDocument {
  const document: Mutable<DesktopSettingsDocument> = {};

  if (settings.localEnvironmentEnabled !== defaults.localEnvironmentEnabled) {
    document.localEnvironmentEnabled = settings.localEnvironmentEnabled;
  }

  if (settings.linuxPasswordStore !== defaults.linuxPasswordStore) {
    document.linuxPasswordStore = settings.linuxPasswordStore;
  }
  const [defaultProfile, ...otherProfiles] = settings.windowProfiles;
  if (defaultProfile !== undefined && defaultProfile.bounds !== null) {
    document.mainWindowBounds = defaultProfile.bounds;
  }
  if (defaultProfile?.maximized === true) {
    document.mainWindowMaximized = true;
  }
  if (
    otherProfiles.length > 0 ||
    (defaultProfile !== undefined && defaultProfile.name !== DEFAULT_WINDOW_PROFILE_NAME)
  ) {
    document.windowProfiles = [
      // The legacy keys carry the default profile's placement.
      ...(defaultProfile === undefined
        ? []
        : [{ id: defaultProfile.id, name: defaultProfile.name }]),
      ...otherProfiles,
    ];
  }
  if (settings.serverExposureMode !== defaults.serverExposureMode) {
    document.serverExposureMode = settings.serverExposureMode;
  }
  if (settings.tailscaleServeEnabled !== defaults.tailscaleServeEnabled) {
    document.tailscaleServeEnabled = settings.tailscaleServeEnabled;
  }
  if (settings.tailscaleServePort !== defaults.tailscaleServePort) {
    document.tailscaleServePort = settings.tailscaleServePort;
  }
  if (settings.updateChannel !== defaults.updateChannel) {
    document.updateChannel = settings.updateChannel;
  }
  if (settings.updateChannelConfiguredByUser !== defaults.updateChannelConfiguredByUser) {
    document.updateChannelConfiguredByUser = settings.updateChannelConfiguredByUser;
  }
  if (settings.wslBackendEnabled !== defaults.wslBackendEnabled) {
    document.wslBackendEnabled = settings.wslBackendEnabled;
  }
  if (settings.wslDistro !== defaults.wslDistro) {
    document.wslDistro = settings.wslDistro;
  }
  if (settings.wslOnly !== defaults.wslOnly) {
    document.wslOnly = settings.wslOnly;
  }

  return document;
}

function setServerExposureMode(
  settings: DesktopSettings,
  requestedMode: DesktopServerExposureMode,
): DesktopSettings {
  return settings.serverExposureMode === requestedMode
    ? settings
    : {
        ...settings,
        serverExposureMode: requestedMode,
      };
}

function setWindowProfilePlacement(
  settings: DesktopSettings,
  profileId: string,
  bounds: DesktopWindowBounds,
  isMaximized: boolean,
): DesktopSettings {
  const profile = settings.windowProfiles.find((candidate) => candidate.id === profileId);
  if (
    profile === undefined ||
    (profile.bounds !== null &&
      desktopWindowBoundsEquivalence(profile.bounds, bounds) &&
      profile.maximized === isMaximized)
  ) {
    return settings;
  }
  return {
    ...settings,
    windowProfiles: settings.windowProfiles.map((candidate) =>
      candidate === profile ? { ...candidate, bounds, maximized: isMaximized } : candidate,
    ),
  };
}

function updateWindowProfiles(
  settings: DesktopSettings,
  update: (
    profiles: ReadonlyArray<DesktopWindowProfileSettings>,
  ) => ReadonlyArray<DesktopWindowProfileSettings>,
): DesktopSettings {
  const updated = update(settings.windowProfiles);
  // Dropping the default profile keeps it as it was; it can only be renamed or moved.
  const windowProfiles = normalizeWindowProfiles(
    updated.some((profile) => profile.id === DEFAULT_DESKTOP_WINDOW_PROFILE_ID)
      ? updated
      : [defaultWindowProfile(settings), ...updated],
  );
  return windowProfilesEqual(windowProfiles, settings.windowProfiles)
    ? settings
    : { ...settings, windowProfiles };
}

function setTailscaleServe(
  settings: DesktopSettings,
  input: { readonly enabled: boolean; readonly port: Option.Option<number> },
): DesktopSettings {
  const port = Option.match(input.port, {
    onNone: () => settings.tailscaleServePort,
    onSome: normalizeTailscaleServePort,
  });
  return settings.tailscaleServeEnabled === input.enabled && settings.tailscaleServePort === port
    ? settings
    : {
        ...settings,
        tailscaleServeEnabled: input.enabled,
        tailscaleServePort: port,
      };
}

function setUpdateChannel(
  settings: DesktopSettings,
  requestedChannel: DesktopUpdateChannel,
): DesktopSettings {
  return settings.updateChannel === requestedChannel
    ? settings
    : {
        ...settings,
        updateChannel: requestedChannel,
        updateChannelConfiguredByUser: true,
      };
}

function setWslBackendEnabled(settings: DesktopSettings, enabled: boolean): DesktopSettings {
  return settings.wslBackendEnabled === enabled
    ? settings
    : {
        ...settings,
        wslBackendEnabled: enabled,
      };
}

function setWslDistro(settings: DesktopSettings, distro: string | null): DesktopSettings {
  const normalized = normalizeWslDistro(distro);
  return settings.wslDistro === normalized
    ? settings
    : {
        ...settings,
        wslDistro: normalized,
      };
}

function setWslOnly(settings: DesktopSettings, enabled: boolean): DesktopSettings {
  return settings.wslOnly === enabled
    ? settings
    : {
        ...settings,
        wslOnly: enabled,
      };
}

function setLocalEnvironmentEnabled(settings: DesktopSettings, enabled: boolean): DesktopSettings {
  return settings.localEnvironmentEnabled === enabled
    ? settings
    : { ...settings, localEnvironmentEnabled: enabled };
}

function applyWslWindowsFallback(settings: DesktopSettings): DesktopSettings {
  return setWslOnly(setWslBackendEnabled(settings, false), false);
}

// Fails only when the file may exist but could not be read; a missing file means defaults.
function readSettings(
  fileSystem: FileSystem.FileSystem,
  settingsPath: string,
  appVersion: string,
): Effect.Effect<DesktopSettings, PlatformError.PlatformError> {
  const defaultSettings = resolveDefaultDesktopSettings(appVersion);

  return fileSystem.readFileString(settingsPath).pipe(
    Effect.asSome,
    Effect.catchIf(
      (cause) => cause.reason._tag === "NotFound",
      () => Effect.succeed(Option.none<string>()),
    ),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(defaultSettings),
        onSome: (raw) =>
          decodeDesktopSettingsJson(raw).pipe(
            Effect.map((parsed) => normalizeDesktopSettingsDocument(parsed, appVersion)),
            Effect.orElseSucceed(() => defaultSettings),
          ),
      }),
    ),
  );
}

const writeSettings = Effect.fn("desktop.settings.writeSettings")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly settingsPath: string;
  readonly settings: DesktopSettings;
  readonly defaultSettings: DesktopSettings;
  readonly suffix: string;
}): Effect.fn.Return<void, DesktopSettingsWriteError> {
  const targetPath = yield* resolveSymlinkTarget(input.settingsPath).pipe(
    Effect.provideService(FileSystem.FileSystem, input.fileSystem),
    Effect.provideService(Path.Path, input.path),
    Effect.mapError(
      (cause) =>
        new DesktopSettingsWriteError({
          operation: "resolve-symlink",
          path: input.settingsPath,
          cause,
        }),
    ),
  );
  const directory = input.path.dirname(targetPath);
  const tempPath = `${targetPath}.${process.pid}.${input.suffix}.tmp`;
  const encoded = yield* encodeDesktopSettingsJson(
    toDesktopSettingsDocument(input.settings, input.defaultSettings),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopSettingsWriteError({
          operation: "encode-document",
          path: input.settingsPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopSettingsWriteError({
          operation: "create-directory",
          path: directory,
          cause,
        }),
    ),
  );
  yield* Effect.gen(function* () {
    yield* input.fileSystem.writeFileString(tempPath, `${encoded}\n`).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopSettingsWriteError({
            operation: "write-temporary-file",
            path: tempPath,
            cause,
          }),
      ),
    );
    yield* input.fileSystem.rename(tempPath, targetPath).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopSettingsWriteError({
            operation: "replace-settings-file",
            path: input.settingsPath,
            cause,
          }),
      ),
    );
  }).pipe(Effect.ensuring(input.fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore)));
});

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const settingsRef = yield* SynchronizedRef.make(environment.defaultDesktopSettings);
  // Writing over a settings file we could not read would erase the preferences it holds.
  const persistenceEnabled = yield* Ref.make(true);

  const updateInMemory = (update: (settings: DesktopSettings) => DesktopSettings) =>
    SynchronizedRef.modify(settingsRef, (settings) => {
      const nextSettings = update(settings);
      return [settingsChange(nextSettings, nextSettings !== settings), nextSettings] as const;
    });

  const persist = (
    update: (settings: DesktopSettings) => DesktopSettings,
  ): Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError> =>
    SynchronizedRef.modifyEffect(settingsRef, (settings) => {
      const nextSettings = update(settings);
      if (nextSettings === settings) {
        return Effect.succeed([settingsChange(settings, false), settings] as const);
      }

      return Ref.get(persistenceEnabled).pipe(
        Effect.flatMap((enabled) =>
          enabled
            ? random.uuidV4().pipe(
                Effect.map((uuid) => uuid.replace(/-/g, "")),
                Effect.flatMap((suffix) =>
                  writeSettings({
                    fileSystem,
                    path,
                    settingsPath: environment.desktopSettingsPath,
                    settings: nextSettings,
                    defaultSettings: environment.defaultDesktopSettings,
                    suffix,
                  }),
                ),
              )
            : Effect.void,
        ),
        Effect.as([settingsChange(nextSettings, true), nextSettings] as const),
      );
    });

  return DesktopAppSettings.of({
    get: SynchronizedRef.get(settingsRef),
    load: Effect.gen(function* () {
      const settings = yield* readSettings(
        fileSystem,
        environment.desktopSettingsPath,
        environment.appVersion,
      ).pipe(
        Effect.catch((cause) =>
          Effect.logWarning(
            "Could not read desktop settings; using defaults without saving changes.",
            cause,
          ).pipe(
            Effect.annotateLogs({ settingsPath: environment.desktopSettingsPath }),
            Effect.andThen(Ref.set(persistenceEnabled, false)),
            Effect.as(resolveDefaultDesktopSettings(environment.appVersion)),
          ),
        ),
      );
      return yield* SynchronizedRef.setAndGet(settingsRef, settings);
    }).pipe(Effect.withSpan("desktop.settings.load")),
    setWindowProfilePlacement: Effect.fn("desktop.settings.setWindowProfilePlacement")(
      function* (profileId, bounds, isMaximized) {
        yield* Effect.annotateCurrentSpan({
          profileId,
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          isMaximized,
        });

        return yield* persist((settings) =>
          setWindowProfilePlacement(settings, profileId, bounds, isMaximized),
        );
      },
    ),
    updateWindowProfiles: Effect.fn("desktop.settings.updateWindowProfiles")(function* (update) {
      return yield* persist((settings) => updateWindowProfiles(settings, update));
    }),
    setServerExposureMode: Effect.fn("desktop.settings.setServerExposureMode")(function* (mode) {
      yield* Effect.annotateCurrentSpan({ mode });

      return yield* persist((settings) => setServerExposureMode(settings, mode));
    }),
    setTailscaleServe: Effect.fn("desktop.settings.setTailscaleServe")(function* (input) {
      yield* Effect.annotateCurrentSpan(input);

      return yield* persist((settings) => setTailscaleServe(settings, input));
    }),
    setUpdateChannel: Effect.fn("desktop.settings.setUpdateChannel")(function* (channel) {
      yield* Effect.annotateCurrentSpan({ channel });

      return yield* persist((settings) => setUpdateChannel(settings, channel));
    }),
    setWslBackendEnabled: Effect.fn("desktop.settings.setWslBackendEnabled")(function* (enabled) {
      yield* Effect.annotateCurrentSpan({ enabled });

      return yield* persist((settings) => setWslBackendEnabled(settings, enabled));
    }),
    setWslDistro: Effect.fn("desktop.settings.setWslDistro")(function* (distro) {
      yield* Effect.annotateCurrentSpan({ distro: distro ?? null });

      return yield* persist((settings) => setWslDistro(settings, distro));
    }),
    setWslOnly: Effect.fn("desktop.settings.setWslOnly")(function* (enabled) {
      yield* Effect.annotateCurrentSpan({ enabled });

      return yield* persist((settings) => setWslOnly(settings, enabled));
    }),
    setLocalEnvironmentEnabled: Effect.fn("desktop.settings.setLocalEnvironmentEnabled")(
      function* (enabled) {
        yield* Effect.annotateCurrentSpan({ enabled });

        return yield* persist((settings) => setLocalEnvironmentEnabled(settings, enabled));
      },
    ),
    applyWslWindowsFallback: persist(applyWslWindowsFallback).pipe(
      Effect.withSpan("desktop.settings.applyWslWindowsFallback"),
    ),
    applyWslWindowsFallbackInMemory: updateInMemory(applyWslWindowsFallback).pipe(
      Effect.withSpan("desktop.settings.applyWslWindowsFallbackInMemory"),
    ),
  });
});

export const layer = Layer.effect(DesktopAppSettings, make);

export const layerTest = (initialSettings: DesktopSettings = DEFAULT_DESKTOP_SETTINGS) =>
  Layer.effect(
    DesktopAppSettings,
    Effect.gen(function* () {
      const settingsRef = yield* SynchronizedRef.make(initialSettings);
      const update = (f: (settings: DesktopSettings) => DesktopSettings) =>
        SynchronizedRef.modify(settingsRef, (settings) => {
          const nextSettings = f(settings);
          return [
            {
              settings: nextSettings,
              changed: nextSettings !== settings,
            },
            nextSettings,
          ] as const;
        });

      return DesktopAppSettings.of({
        get: SynchronizedRef.get(settingsRef),
        load: SynchronizedRef.get(settingsRef),
        setWindowProfilePlacement: Effect.fn("DesktopAppSettings.setWindowProfilePlacement")(
          function (profileId, bounds, isMaximized) {
            return update((settings) =>
              setWindowProfilePlacement(settings, profileId, bounds, isMaximized),
            );
          },
        ),
        updateWindowProfiles: Effect.fn("DesktopAppSettings.updateWindowProfiles")(
          function (profilesUpdate) {
            return update((settings) => updateWindowProfiles(settings, profilesUpdate));
          },
        ),
        setServerExposureMode: Effect.fn("DesktopAppSettings.setServerExposureMode")(
          function (mode) {
            return update((settings) => setServerExposureMode(settings, mode));
          },
        ),
        setTailscaleServe: Effect.fn("DesktopAppSettings.setTailscaleServe")(function (input) {
          return update((settings) => setTailscaleServe(settings, input));
        }),
        setUpdateChannel: Effect.fn("DesktopAppSettings.setUpdateChannel")(function (channel) {
          return update((settings) => setUpdateChannel(settings, channel));
        }),
        setWslBackendEnabled: Effect.fn("DesktopAppSettings.setWslBackendEnabled")(
          function (enabled) {
            return update((settings) => setWslBackendEnabled(settings, enabled));
          },
        ),
        setWslDistro: Effect.fn("DesktopAppSettings.setWslDistro")(function (distro) {
          return update((settings) => setWslDistro(settings, distro));
        }),
        setWslOnly: Effect.fn("DesktopAppSettings.setWslOnly")(function (enabled) {
          return update((settings) => setWslOnly(settings, enabled));
        }),
        setLocalEnvironmentEnabled: Effect.fn("DesktopAppSettings.setLocalEnvironmentEnabled")(
          function (enabled) {
            return update((settings) => setLocalEnvironmentEnabled(settings, enabled));
          },
        ),
        applyWslWindowsFallback: update(applyWslWindowsFallback),
        applyWslWindowsFallbackInMemory: update(applyWslWindowsFallback),
      });
    }),
  );
