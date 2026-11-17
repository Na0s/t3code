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
  /** Adds or replaces one worktree-mode thread's folder, which `replace` leaves alone. */
  readonly registerWorktree: (
    resolvedRoot: string,
    members: ReadonlyArray<UmbrellaMemberCheckout>,
  ) => Effect.Effect<void>;
  readonly forgetWorktree: (resolvedRoot: string) => Effect.Effect<void>;
  readonly membersOf: (resolvedRoot: string) => ReadonlyArray<UmbrellaMemberCheckout>;
  readonly hasMembers: () => boolean;
  /** Members of the umbrella rooted at this work tree that sit inside it, relative with `/` separators. */
  readonly memberPathsWithin: (resolvedWorktreeRoot: string) => ReadonlyArray<string>;
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
  const lookup = (root: string) => umbrellas.get(root) ?? worktrees.get(root) ?? EMPTY;
  return {
    replace: (next) =>
      Effect.sync(() => {
        umbrellas = new Map(
          Array.from(next, ([root, members]) => [NodePath.resolve(root), members] as const),
        );
      }),
    registerWorktree: (resolvedRoot, members) =>
      Effect.sync(() => {
        worktrees.set(NodePath.resolve(resolvedRoot), members);
      }),
    forgetWorktree: (resolvedRoot) =>
      Effect.sync(() => {
        worktrees.delete(NodePath.resolve(resolvedRoot));
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
    }),
  },
) {}

export const layer = Layer.sync(UmbrellaMemberIndex, makeIndex);
