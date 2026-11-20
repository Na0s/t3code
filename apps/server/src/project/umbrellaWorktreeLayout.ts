// A worktree-mode umbrella thread works in one folder that mirrors the umbrella: the root's own
// worktree with a worktree of every member at its path. A manifest beside the folder records
// which repositories it holds.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { UmbrellaMemberIndex } from "../vcs/UmbrellaMemberIndex.ts";

export const UMBRELLA_WORKTREE_MANIFEST_SUFFIX = ".t3-umbrella.json";

const UmbrellaWorktreeManifest = Schema.Struct({
  version: Schema.Literal(1),
  umbrellaRoot: Schema.String,
  /** `path` is relative to the thread's folder, with `/` separators; `source` is the member's own checkout. */
  members: Schema.Array(Schema.Struct({ source: Schema.String, path: Schema.String })),
});
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(UmbrellaWorktreeManifest));
export const encodeUmbrellaWorktreeManifest = Schema.encodeEffect(
  Schema.fromJsonString(UmbrellaWorktreeManifest),
);

export interface UmbrellaWorktreeLayout extends Omit<
  typeof UmbrellaWorktreeManifest.Type,
  "version"
> {
  /** The thread's folder. */
  readonly path: string;
}

/** One repository checked out in an umbrella worktree. `relativePath` is "" for the root's own. */
export interface UmbrellaWorktreeRepository {
  readonly cwd: string;
  readonly source: string;
  readonly relativePath: string;
}

export class UmbrellaWorktreeError extends Schema.TaggedError<UmbrellaWorktreeError>()(
  "UmbrellaWorktreeError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const umbrellaWorktreeManifestPath = (path: Path.Path, worktreePath: string) =>
  `${path.resolve(worktreePath)}${UMBRELLA_WORKTREE_MANIFEST_SUFFIX}`;

export const joinUmbrellaRelative = (path: Path.Path, root: string, relativePath: string) =>
  relativePath === "" ? root : path.join(root, ...relativePath.split("/"));

/** The repositories in an umbrella worktree: the root's own first. */
export const umbrellaWorktreeRepositories = (
  path: Path.Path,
  layout: UmbrellaWorktreeLayout,
): ReadonlyArray<UmbrellaWorktreeRepository> => [
  { cwd: layout.path, source: layout.umbrellaRoot, relativePath: "" },
  ...layout.members.map((member) => ({
    cwd: joinUmbrellaRelative(path, layout.path, member.path),
    source: member.source,
    relativePath: member.path,
  })),
];

/** The umbrella worktree at this folder, or null when it is not one. */
export const readUmbrellaWorktree = Effect.fn("UmbrellaWorktree.read")(
  function* (worktreePath: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const contents = yield* fileSystem
      .readFileString(umbrellaWorktreeManifestPath(path, worktreePath))
      .pipe(Effect.option);
    if (Option.isNone(contents)) return null;
    const { version: _version, ...manifest } = yield* decodeManifest(contents.value);
    return { ...manifest, path: path.resolve(worktreePath) } satisfies UmbrellaWorktreeLayout;
  },
  Effect.orElseSucceed(() => null),
);

/** `readUmbrellaWorktree` bound to the caller's file system and paths, for services built with them. */
export const makeReadUmbrellaWorktree = Effect.map(
  Effect.context<FileSystem.FileSystem | Path.Path>(),
  (context) => (worktreePath: string) =>
    readUmbrellaWorktree(worktreePath).pipe(Effect.provideContext(context)),
);

/** Lets checkpoints and Git status of the folder treat its members as the umbrella's do. */
export const registerUmbrellaWorktree = Effect.fn("UmbrellaWorktree.register")(function* (
  layout: UmbrellaWorktreeLayout,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const index = yield* UmbrellaMemberIndex;
  const realPath = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));
  const members = yield* Effect.forEach(layout.members, (member) =>
    realPath(joinUmbrellaRelative(path, layout.path, member.path)).pipe(
      Effect.map((memberPath) => ({ path: memberPath, relativePath: member.path })),
    ),
  );
  yield* index.registerWorktree(yield* realPath(layout.path), members);
});

/** Reads and registers the umbrella worktree at `cwd`, for callers that may run before the startup scan. */
export const loadUmbrellaWorktree = Effect.fn("UmbrellaWorktree.load")(function* (cwd: string) {
  const layout = yield* readUmbrellaWorktree(cwd);
  if (layout !== null) yield* registerUmbrellaWorktree(layout);
  return layout;
});

/** Registers every umbrella worktree whose manifest sits in these worktree folders. */
export const registerUmbrellaWorktreesIn = Effect.fn("UmbrellaWorktree.registerIn")(function* (
  directories: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const list = (directory: string) =>
    fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed((): string[] => []));
  for (const directory of directories) {
    for (const group of yield* list(directory)) {
      for (const name of yield* list(path.join(directory, group))) {
        if (!name.endsWith(UMBRELLA_WORKTREE_MANIFEST_SUFFIX)) continue;
        yield* loadUmbrellaWorktree(
          path.join(directory, group, name.slice(0, -UMBRELLA_WORKTREE_MANIFEST_SUFFIX.length)),
        );
      }
    }
  }
});
