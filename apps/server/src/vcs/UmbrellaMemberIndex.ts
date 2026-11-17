// @effect-diagnostics nodeBuiltinImport:off
// Git reads consult this synchronously, so a repository's own status, diffs, and checkpoints
// leave out the umbrella members checked out inside it.
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface UmbrellaMemberCheckout {
  /** Symlink-resolved absolute path. */
  readonly path: string;
  /** Relative to the umbrella root, with `/` separators. */
  readonly relativePath: string;
}

export interface UmbrellaMemberIndexShape {
  /** Replaces every umbrella, keyed by symlink-resolved root. */
  readonly replace: (
    umbrellas: ReadonlyMap<string, ReadonlyArray<UmbrellaMemberCheckout>>,
  ) => Effect.Effect<void>;
  /**
   * Adds or replaces one worktree-mode thread's folder, which `replace` leaves alone. A plain
   * folder passes every spelling of its path as `plainAliases`, so Git never searches above it.
   */
  readonly registerWorktree: (
    resolvedRoot: string,
    members: ReadonlyArray<UmbrellaMemberCheckout>,
    plainAliases?: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
  readonly forgetWorktree: (resolvedRoot: string) => Effect.Effect<void>;
  readonly membersOf: (resolvedRoot: string) => ReadonlyArray<UmbrellaMemberCheckout>;
  readonly hasMembers: () => boolean;
  /** Members of the umbrella rooted at this work tree that sit inside it, relative with `/` separators. */
  readonly memberPathsWithin: (resolvedWorktreeRoot: string) => ReadonlyArray<string>;
  /**
   * For a cwd in a plain umbrella worktree folder, the `GIT_CEILING_DIRECTORIES` that keeps Git
   * from finding a repository that merely encloses the folder, such as a T3 home inside one.
   */
  readonly gitCeilingFor: (cwd: string) => string | null;
}

const EMPTY: ReadonlyArray<never> = [];

const isStrictlyWithin = (root: string, candidate: string) => {
  const relative = NodePath.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
};

export const makeIndex = (): UmbrellaMemberIndexShape => {
  let umbrellas = new Map<string, ReadonlyArray<UmbrellaMemberCheckout>>();
  const worktrees = new Map<string, ReadonlyArray<UmbrellaMemberCheckout>>();
  // Alias of a plain worktree folder → its registered root.
  const plainFolders = new Map<string, string>();
  const lookup = (root: string) => umbrellas.get(root) ?? worktrees.get(root) ?? EMPTY;
  return {
    replace: (next) =>
      Effect.sync(() => {
        umbrellas = new Map(
          Array.from(next, ([root, members]) => [NodePath.resolve(root), members] as const),
        );
      }),
    registerWorktree: (resolvedRoot, members, plainAliases) =>
      Effect.sync(() => {
        const root = NodePath.resolve(resolvedRoot);
        worktrees.set(root, members);
        for (const alias of plainAliases ?? []) plainFolders.set(NodePath.resolve(alias), root);
      }),
    forgetWorktree: (resolvedRoot) =>
      Effect.sync(() => {
        const root = NodePath.resolve(resolvedRoot);
        worktrees.delete(root);
        for (const [alias, owner] of plainFolders) if (owner === root) plainFolders.delete(alias);
      }),
    membersOf: (resolvedRoot) => lookup(NodePath.resolve(resolvedRoot)),
    hasMembers: () => umbrellas.size > 0 || worktrees.size > 0,
    memberPathsWithin: (resolvedWorktreeRoot) => {
      if (umbrellas.size === 0 && worktrees.size === 0) return EMPTY;
      const root = NodePath.resolve(resolvedWorktreeRoot);
      return lookup(root)
        .map((member) => NodePath.resolve(member.path))
        .filter((member) => isStrictlyWithin(root, member))
        .map((member) => NodePath.relative(root, member).split(NodePath.sep).join("/"));
    },
    gitCeilingFor: (cwd) => {
      if (plainFolders.size === 0) return null;
      const target = NodePath.resolve(cwd);
      for (const alias of plainFolders.keys()) {
        if (target === alias || isStrictlyWithin(alias, target)) return NodePath.dirname(alias);
      }
      return null;
    },
  };
};

/** Defaults to an empty index, so git keeps its plain behavior wherever no umbrella layer is provided. */
export class UmbrellaMemberIndex extends Context.Reference<UmbrellaMemberIndexShape>(
  "t3/vcs/UmbrellaMemberIndex",
  {
    defaultValue: () => ({
      replace: () => Effect.void,
      registerWorktree: () => Effect.void,
      forgetWorktree: () => Effect.void,
      membersOf: () => EMPTY,
      hasMembers: () => false,
      memberPathsWithin: () => EMPTY,
      gitCeilingFor: () => null,
    }),
  },
) {}

export const layer = Layer.sync(UmbrellaMemberIndex, makeIndex);
