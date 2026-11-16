import type {
  ProjectId,
  ProjectSettingsOverrides,
  RepositoryIdentity,
  ServerSettings as ServerSettingsSchema,
  UmbrellaMember,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { UmbrellaMemberIndex, type UmbrellaMemberCheckout } from "../vcs/UmbrellaMemberIndex.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";

interface UmbrellaProject {
  readonly id: ProjectId;
  readonly workspaceRoot: string;
}

const EMPTY_PATHS: ReadonlyArray<string> = [];

function umbrellaSettingsOf(
  overrides:
    | Pick<ProjectSettingsOverrides, "umbrellaAdoptedPaths" | "umbrellaExcludedPaths">
    | undefined,
) {
  return {
    adopted: overrides?.umbrellaAdoptedPaths ?? EMPTY_PATHS,
    excluded: overrides?.umbrellaExcludedPaths ?? EMPTY_PATHS,
  };
}

/**
 * Discovered checkouts plus adopted ones, minus exclusions, ordered by relative path. Relative
 * settings paths resolve against the root; a checkout found both ways counts as nested.
 */
export function resolveUmbrellaMembers(input: {
  readonly path: Path.Path;
  readonly workspaceRoot: string;
  readonly nested: ReadonlyArray<string>;
  readonly adopted: ReadonlyArray<string>;
  readonly excluded: ReadonlyArray<string>;
  readonly identityOf: (memberPath: string) => RepositoryIdentity | null;
}): ReadonlyArray<UmbrellaMember> {
  const { path } = input;
  const root = path.resolve(input.workspaceRoot);
  const resolve = (value: string) => path.resolve(root, value);
  const excluded = new Set(input.excluded.map(resolve));
  const members = new Map<string, UmbrellaMember["source"]>();
  for (const nested of input.nested) members.set(resolve(nested), "nested");
  for (const adopted of input.adopted) {
    const memberPath = resolve(adopted);
    if (!members.has(memberPath)) members.set(memberPath, "adopted");
  }
  return Array.from(members, ([memberPath, source]) => ({ memberPath, source }))
    .filter(({ memberPath }) => memberPath !== root && !excluded.has(memberPath))
    .map(({ memberPath, source }) => ({
      path: memberPath,
      relativePath: path.relative(root, memberPath).split(path.sep).join("/"),
      repositoryIdentity: input.identityOf(memberPath),
      source,
    }))
    .toSorted((left, right) => left.relativePath.localeCompare(right.relativePath));
}

const sameSettings = (
  left: ReturnType<typeof umbrellaSettingsOf>,
  right: ReturnType<typeof umbrellaSettingsOf>,
) =>
  left.adopted.join("\0") === right.adopted.join("\0") &&
  left.excluded.join("\0") === right.excluded.join("\0");

export class UmbrellaMembership extends Context.Service<
  UmbrellaMembership,
  {
    /** From cached discovery and identities, never scanning inline; undefined before the root's first scan. */
    readonly membersOf: (
      project: UmbrellaProject,
    ) => Effect.Effect<ReadonlyArray<UmbrellaMember> | undefined>;
    /** Projects whose adopted or excluded checkouts changed in settings. */
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

  const resolveFor = (
    project: UmbrellaProject,
    nested: ReadonlyArray<string>,
    overrides: ServerSettingsSchema["projectSettingsOverrides"],
    identityOf: (memberPath: string) => RepositoryIdentity | null,
  ) =>
    resolveUmbrellaMembers({
      path,
      workspaceRoot: project.workspaceRoot,
      nested,
      ...umbrellaSettingsOf(overrides[project.id]),
      identityOf,
    });

  const membersOf: UmbrellaMembership["Service"]["membersOf"] = Effect.fnUntraced(
    function* (project) {
      const nested = yield* enrichment.peekNestedRepositories(project.workspaceRoot);
      if (nested === null) return undefined;
      const overrides = yield* readSettings;
      const { adopted } = umbrellaSettingsOf(overrides[project.id]);
      if (nested.length === 0 && adopted.length === 0) return [];
      const candidates = resolveFor(project, nested, overrides, () => null);
      const identities = new Map(
        yield* Effect.forEach(candidates, (member) =>
          enrichment
            .getAvailable(member.path)
            .pipe(
              Effect.map(({ repositoryIdentity }) => [member.path, repositoryIdentity] as const),
            ),
        ),
      );
      return candidates.map((member) => ({
        ...member,
        repositoryIdentity: identities.get(member.path) ?? null,
      }));
    },
  );

  const realPath = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => path.resolve(value)));

  // Git consults the index on every read, so it holds only the members' resolved paths.
  const rebuildIndex = Effect.fn("UmbrellaMembership.rebuildIndex")(function* (options: {
    readonly scan: boolean;
  }) {
    const projects = yield* projectStore.listShells().pipe(Effect.orElseSucceed(() => []));
    const overrides = yield* readSettings;
    const umbrellas = new Map<string, ReadonlyArray<UmbrellaMemberCheckout>>();
    yield* Effect.forEach(
      projects,
      (project) =>
        Effect.gen(function* () {
          const nested = options.scan
            ? yield* enrichment.readNestedRepositories(project.workspaceRoot)
            : ((yield* enrichment.peekNestedRepositories(project.workspaceRoot)) ?? EMPTY_PATHS);
          const members = resolveFor(project, nested, overrides, () => null);
          if (members.length === 0) return;
          const root = yield* realPath(project.workspaceRoot);
          const checkouts = yield* Effect.forEach(members, (member) =>
            realPath(member.path).pipe(
              Effect.map((resolved) => ({
                path: resolved,
                relativePath: member.relativePath,
              })),
            ),
          );
          umbrellas.set(root, [...(umbrellas.get(root) ?? []), ...checkouts]);
        }),
      { concurrency: 2, discard: true },
    );
    yield* index.replace(umbrellas);
  });

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

  yield* forkParked(
    Effect.gen(function* () {
      yield* rebuildIndex({ scan: true });
      yield* Effect.all(
        [
          Stream.runForEach(settingsChanges, onSettings),
          Stream.fromSubscription(enrichmentChanges).pipe(
            Stream.filter((change) => change.nestedRepositoriesResolved === true),
            Stream.groupedWithin(64, Duration.millis(250)),
            Stream.runForEach(() => rebuildIndex({ scan: false })),
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
    membersOf,
    subscribeChanges: PubSub.subscribe(changes),
  });
});

export const layer = Layer.effect(UmbrellaMembership, make);

/** Adds `umbrellaMembers` once the root has been scanned. Runtimes without the umbrella layer keep plain shells. */
export const attachUmbrellaMembers = Effect.fnUntraced(function* <P extends UmbrellaProject>(
  projects: ReadonlyArray<P>,
) {
  const membership = yield* Effect.serviceOption(UmbrellaMembership);
  if (Option.isNone(membership)) return projects;
  return yield* Effect.forEach(
    projects,
    (project) =>
      membership.value
        .membersOf(project)
        .pipe(
          Effect.map((umbrellaMembers) =>
            umbrellaMembers === undefined ? project : { ...project, umbrellaMembers },
          ),
        ),
    { concurrency: 16 },
  );
});
