import type {
  ProjectId,
  ProjectSettingsOverrides,
  ServerSettings as ServerSettingsSchema,
  UmbrellaMember,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { UmbrellaMemberIndex, type UmbrellaMemberCheckout } from "../vcs/UmbrellaMemberIndex.ts";
import { managedWorktreesDirectories } from "../worktreesDirectory.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import { registerUmbrellaWorktreesIn } from "./umbrellaWorktreeLayout.ts";

interface UmbrellaProject {
  readonly id: ProjectId;
  readonly workspaceRoot: string;
}

interface UmbrellaState {
  readonly members: ReadonlyArray<UmbrellaMember>;
  readonly suggestions: ReadonlyArray<UmbrellaMember>;
  readonly enclosingRepository: string | null;
}

const EMPTY_PATHS: ReadonlyArray<string> = [];
const EMPTY_STATE: UmbrellaState = { members: [], suggestions: [], enclosingRepository: null };

/** Adopting a checkout turns the umbrella on, so only discovery waits for the user's confirmation. */
function umbrellaSettingsOf(
  overrides:
    | Pick<
        ProjectSettingsOverrides,
        "umbrellaEnabled" | "umbrellaAdoptedPaths" | "umbrellaExcludedPaths"
      >
    | undefined,
) {
  return {
    enabled: overrides?.umbrellaEnabled === true,
    adopted: overrides?.umbrellaAdoptedPaths ?? EMPTY_PATHS,
    excluded: overrides?.umbrellaExcludedPaths ?? EMPTY_PATHS,
  };
}
type UmbrellaSettings = ReturnType<typeof umbrellaSettingsOf>;

/**
 * Discovered checkouts plus adopted ones, minus exclusions; a checkout found both ways is nested.
 * They are suggestions until the user turns the umbrella on. A root inside another repository's
 * work tree cannot be one: that repository's paths are relative to its own top level.
 */
export function umbrellaStateOf(input: {
  readonly path: Path.Path;
  readonly workspaceRoot: string;
  readonly nested: ReadonlyArray<string>;
  readonly settings: UmbrellaSettings;
  readonly enclosingRepository: string | null;
}): UmbrellaState {
  if (input.enclosingRepository !== null) {
    return { ...EMPTY_STATE, enclosingRepository: input.enclosingRepository };
  }
  const { path, settings } = input;
  const root = path.resolve(input.workspaceRoot);
  const resolve = (value: string) => path.resolve(root, value);
  const excluded = new Set(settings.excluded.map(resolve));
  const sources = new Map<string, UmbrellaMember["source"]>();
  for (const nested of input.nested) sources.set(resolve(nested), "nested");
  for (const adopted of settings.adopted) {
    const memberPath = resolve(adopted);
    if (!sources.has(memberPath)) sources.set(memberPath, "adopted");
  }
  const candidates = Array.from(sources, ([memberPath, source]) => ({
    path: memberPath,
    relativePath: path.relative(root, memberPath).split(path.sep).join("/"),
    repositoryIdentity: null,
    source,
  }))
    .filter((member) => member.path !== root && !excluded.has(member.path))
    .toSorted((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (candidates.length === 0) return EMPTY_STATE;
  return settings.enabled
    ? { ...EMPTY_STATE, members: candidates }
    : { ...EMPTY_STATE, suggestions: candidates };
}

const sameSettings = (left: UmbrellaSettings, right: UmbrellaSettings) =>
  left.enabled === right.enabled &&
  left.adopted.join("\0") === right.adopted.join("\0") &&
  left.excluded.join("\0") === right.excluded.join("\0");

export class UmbrellaMembership extends Context.Service<
  UmbrellaMembership,
  {
    /** From cached scans and identities, never scanning inline; undefined before the root's first scan. */
    readonly stateOf: (project: UmbrellaProject) => Effect.Effect<UmbrellaState | undefined>;
    /** Recomputes which checkouts git leaves out, after projects move or go away. */
    readonly refreshIndex: Effect.Effect<void>;
    /** Projects whose members may have changed: settings edits, root rescans, member identities. */
    readonly subscribeChanges: Effect.Effect<
      PubSub.Subscription<ReadonlyArray<ProjectId>>,
      never,
      Scope.Scope
    >;
  }
>()("t3/project/UmbrellaMembership") {}

/** @public */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const enrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const index = yield* UmbrellaMemberIndex;
  const changes = yield* Effect.acquireRelease(
    PubSub.sliding<ReadonlyArray<ProjectId>>(64),
    (pubsub) => PubSub.shutdown(pubsub),
  );

  const readSettings = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.projectSettingsOverrides),
    Effect.orElseSucceed((): ServerSettingsSchema["projectSettingsOverrides"] => ({})),
  );

  // A folder rarely moves into or out of a repository, so the answer is kept per root.
  const enclosingRepositories = new Map<string, string | null>();
  const enclosingRepositoryOf = Effect.fnUntraced(function* (workspaceRoot: string) {
    const cached = enclosingRepositories.get(workspaceRoot);
    if (cached !== undefined) return cached;
    const hasGit = (directory: string) =>
      fileSystem.exists(path.join(directory, ".git")).pipe(Effect.orElseSucceed(() => false));
    let enclosing: string | null = null;
    if (!(yield* hasGit(workspaceRoot))) {
      let directory = path.dirname(path.resolve(workspaceRoot));
      while (enclosing === null) {
        if (yield* hasGit(directory)) enclosing = directory;
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    enclosingRepositories.set(workspaceRoot, enclosing);
    return enclosing;
  });

  const stateFor = Effect.fnUntraced(function* (
    project: UmbrellaProject,
    overrides: ServerSettingsSchema["projectSettingsOverrides"],
    scan: "peek" | "read",
  ) {
    const settings = umbrellaSettingsOf(overrides[project.id]);
    const nested =
      scan === "read"
        ? yield* enrichment.readNestedRepositories(project.workspaceRoot)
        : yield* enrichment.peekNestedRepositories(project.workspaceRoot, {
            rescanWhenStale: settings.enabled,
          });
    if (nested === null) return undefined;
    return umbrellaStateOf({
      path,
      workspaceRoot: project.workspaceRoot,
      nested,
      settings,
      enclosingRepository: yield* enclosingRepositoryOf(project.workspaceRoot),
    });
  });

  const stateOf: UmbrellaMembership["Service"]["stateOf"] = Effect.fnUntraced(function* (project) {
    const state = yield* stateFor(project, yield* readSettings, "peek");
    if (state === undefined || state.members.length === 0) return state;
    const members = yield* Effect.forEach(state.members, (member) =>
      enrichment
        .getAvailable(member.path)
        .pipe(Effect.map(({ repositoryIdentity }) => ({ ...member, repositoryIdentity }))),
    );
    return { ...state, members };
  });

  const realPath = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => path.resolve(value)));

  let umbrellasByMemberPath = new Map<string, ReadonlyArray<ProjectId>>();
  // Serialized, with settings read inside, so a slow rebuild cannot restore what a later one dropped.
  const rebuildLock = yield* Semaphore.make(1);
  const rebuildIndex = Effect.fn("UmbrellaMembership.rebuildIndex")(
    function* (options: { readonly scan: boolean }) {
      const projects = yield* projectStore.listShells().pipe(Effect.orElseSucceed(() => []));
      const overrides = yield* readSettings;
      const umbrellas = new Map<string, ReadonlyArray<UmbrellaMemberCheckout>>();
      const byMemberPath = new Map<string, ProjectId[]>();
      yield* Effect.forEach(
        projects,
        (project) =>
          Effect.gen(function* () {
            // Git only leaves out the members of umbrellas the user turned on.
            if (!umbrellaSettingsOf(overrides[project.id]).enabled) return;
            const state = yield* stateFor(project, overrides, options.scan ? "read" : "peek");
            if (state === undefined || state.members.length === 0) return;
            for (const member of state.members) {
              byMemberPath.set(member.path, [...(byMemberPath.get(member.path) ?? []), project.id]);
            }
            const root = yield* realPath(project.workspaceRoot);
            const checkouts = yield* Effect.forEach(state.members, (member) =>
              realPath(member.path).pipe(
                Effect.map((resolved) => ({ path: resolved, relativePath: member.relativePath })),
              ),
            );
            umbrellas.set(root, [...(umbrellas.get(root) ?? []), ...checkouts]);
          }),
        { concurrency: 2, discard: true },
      );
      yield* index.replace(umbrellas);
      umbrellasByMemberPath = byMemberPath;
    },
    (effect) => rebuildLock.withPermits(1)(effect),
  );

  const settingsChanges = yield* settingsService.subscribeChanges;
  const enrichmentChanges = yield* enrichment.subscribeChanges;
  let lastSettings = new Map(
    Object.entries(yield* readSettings).map(([projectId, entry]) => [
      projectId,
      umbrellaSettingsOf(entry),
    ]),
  );
  const onSettings = Effect.fn("UmbrellaMembership.onSettings")(function* (
    settings: ServerSettingsSchema,
  ) {
    const next = new Map(
      Object.entries(settings.projectSettingsOverrides).map(([projectId, entry]) => [
        projectId,
        umbrellaSettingsOf(entry),
      ]),
    );
    const changed = [...new Set([...lastSettings.keys(), ...next.keys()])].filter(
      (projectId) =>
        !sameSettings(
          lastSettings.get(projectId) ?? umbrellaSettingsOf(undefined),
          next.get(projectId) ?? umbrellaSettingsOf(undefined),
        ),
    ) as ProjectId[];
    lastSettings = next;
    if (changed.length === 0) return;
    yield* rebuildIndex({ scan: false });
    yield* PubSub.publish(changes, changed);
  });

  // A rescan changes its root's members; a resolved identity changes the umbrellas holding it.
  const onEnrichment = Effect.fn("UmbrellaMembership.onEnrichment")(function* (
    batch: ReadonlyArray<ProjectEnrichmentService.ProjectEnrichmentChange>,
  ) {
    const rescanned = new Set(
      batch.flatMap((change) =>
        change.nestedRepositoriesResolved === true ? [change.workspaceRoot] : [],
      ),
    );
    if (rescanned.size > 0) yield* rebuildIndex({ scan: false });
    const changed = new Set(
      batch.flatMap((change) =>
        change.repositoryIdentityResolved
          ? (umbrellasByMemberPath.get(change.workspaceRoot) ?? [])
          : [],
      ),
    );
    if (rescanned.size > 0) {
      for (const project of yield* projectStore.listShells().pipe(Effect.orElseSucceed(() => []))) {
        if (rescanned.has(project.workspaceRoot)) changed.add(project.id);
      }
    }
    if (changed.size > 0) yield* PubSub.publish(changes, [...changed]);
  });

  const serverConfig = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  // Worktree-mode threads' folders, so their status and checkpoints leave members out after a restart.
  const registerWorktrees = Effect.gen(function* () {
    if (Option.isNone(serverConfig)) return;
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed(() => ({ worktreesDirectory: "", previousWorktreesDirectories: [] })),
    );
    yield* registerUmbrellaWorktreesIn(
      managedWorktreesDirectories(
        settings,
        serverConfig.value.worktreesDir,
        path,
        yield* HostProcess.HomeDirectory,
      ),
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(UmbrellaMemberIndex, index),
    );
  });

  yield* forkParked(
    Effect.gen(function* () {
      yield* registerWorktrees;
      yield* rebuildIndex({ scan: true });
      yield* Effect.all(
        [
          Stream.runForEach(settingsChanges, onSettings),
          Stream.fromSubscription(enrichmentChanges).pipe(
            Stream.groupedWithin(64, Duration.millis(250)),
            Stream.runForEach(onEnrichment),
          ),
          // Rescans enabled umbrellas and drops projects removed or moved since.
          rebuildIndex({ scan: false }).pipe(
            Effect.repeat(Schedule.spaced(Duration.minutes(5))),
            Effect.delay(Duration.minutes(5)),
          ),
        ],
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Umbrella membership sync stopped", { cause }),
      ),
    ),
  );

  return UmbrellaMembership.of({
    stateOf,
    refreshIndex: rebuildIndex({ scan: false }),
    subscribeChanges: PubSub.subscribe(changes),
  });
});

export const layer = Layer.effect(UmbrellaMembership, make);

/** Adds umbrella members or suggestions once the root has been scanned. Runtimes without the umbrella layer keep plain shells. */
export const attachUmbrellaMembers = Effect.fnUntraced(function* <P extends UmbrellaProject>(
  projects: ReadonlyArray<P>,
) {
  const membership = yield* Effect.serviceOption(UmbrellaMembership);
  if (Option.isNone(membership)) return projects;
  return yield* Effect.forEach(
    projects,
    (project) =>
      membership.value.stateOf(project).pipe(
        Effect.map((state) =>
          state === undefined
            ? project
            : {
                ...project,
                umbrellaMembers: state.members,
                ...(state.suggestions.length > 0 ? { umbrellaSuggestions: state.suggestions } : {}),
                ...(state.enclosingRepository === null
                  ? {}
                  : { umbrellaEnclosingRepository: state.enclosingRepository }),
              },
        ),
      ),
    { concurrency: 16 },
  );
});

/** Looks the umbrella layer up once: a project's enabled members, or none without the layer. */
export const makeUmbrellaMembersOf = Effect.map(
  Effect.serviceOption(UmbrellaMembership),
  (membership) =>
    (project: UmbrellaProject): Effect.Effect<ReadonlyArray<UmbrellaMember>> =>
      Option.isNone(membership)
        ? Effect.succeed([])
        : membership.value.stateOf(project).pipe(Effect.map((state) => state?.members ?? [])),
);

/** Projects whose members may have changed; nothing without the umbrella layer. */
export const subscribeUmbrellaChanges = Effect.serviceOption(UmbrellaMembership).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.succeed(Stream.empty),
      onSome: (membership) => Effect.map(membership.subscribeChanges, Stream.fromSubscription),
    }),
  ),
);

/** A moved or deleted project stops git leaving out its members right away. */
export const refreshUmbrellaIndex = Effect.serviceOption(UmbrellaMembership).pipe(
  Effect.flatMap(
    Option.match({ onNone: () => Effect.void, onSome: (membership) => membership.refreshIndex }),
  ),
);
