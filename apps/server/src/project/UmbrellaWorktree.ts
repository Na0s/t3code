import type { UmbrellaMember, WorktreeSubmodules } from "@t3tools/contracts";
import { umbrellaWorktreeMemberPaths } from "@t3tools/shared/umbrellaWorktree";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { UmbrellaMemberIndex } from "../vcs/UmbrellaMemberIndex.ts";
import { recreateBranchWorktree } from "../workspace/recreateBranchWorktree.ts";
import {
  encodeUmbrellaWorktreeManifest,
  joinUmbrellaRelative,
  readUmbrellaWorktree,
  registerUmbrellaWorktree,
  UmbrellaWorktreeError,
  type UmbrellaWorktreeLayout,
  type UmbrellaWorktreeRepository,
  umbrellaWorktreeManifestPath,
  umbrellaWorktreeRepositories,
} from "./umbrellaWorktreeLayout.ts";

interface CreateUmbrellaWorktreeInput {
  readonly umbrellaRoot: string;
  /** The umbrella's enabled members. */
  readonly members: ReadonlyArray<Pick<UmbrellaMember, "path" | "relativePath">>;
  /** "HEAD" starts each repository from its own checkout. */
  readonly baseRef: string;
  readonly startFromOrigin: boolean;
  readonly branch: string;
  /** A temporary name that collides with an existing branch folder gets flattened, as plain worktrees do. */
  readonly flattenOnConflict: boolean;
  readonly submodules: WorktreeSubmodules | null;
}

/** @public */
export const makeUmbrellaWorktrees = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const index = yield* UmbrellaMemberIndex;
  const local = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(GitWorkflowService.GitWorkflowService, git),
      Effect.provideService(UmbrellaMemberIndex, index),
    );

  const fail = (operation: string, detail: string, cause?: unknown) =>
    new UmbrellaWorktreeError({
      operation,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const errorDetail = (cause: unknown) =>
    cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);
  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));

  /** Where a repository starts: the requested base when it has one, else its own checkout. */
  const resolveBase = Effect.fn("UmbrellaWorktree.resolveBase")(function* (
    cwd: string,
    baseRef: string,
    startFromOrigin: boolean,
  ) {
    // Untraced: resolveBase's span covers it.
    const fromOrigin = Effect.fnUntraced(function* (refName: string) {
      if (!startFromOrigin) return null;
      const remote = yield* git.resolveWorktreeBaseRemote({ cwd, refName });
      if (remote === null) return null;
      const fetched = yield* git.fetchWorktreeBaseCommit({ cwd, refName, remote });
      return fetched === null
        ? null
        : { startRef: fetched.commitSha, baseRefName: `refs/remotes/${fetched.remoteRefName}` };
    });
    if (baseRef !== "HEAD") {
      const remote = yield* fromOrigin(baseRef);
      if (remote !== null) return remote;
      if (yield* git.hasCommit({ cwd, refName: baseRef })) {
        return { startRef: baseRef, baseRefName: baseRef };
      }
    }
    const current = yield* git.currentBranch(cwd);
    if (current !== null) {
      return (yield* fromOrigin(current)) ?? { startRef: current, baseRefName: current };
    }
    if (yield* git.hasCommit({ cwd, refName: "HEAD" })) {
      return { startRef: "HEAD", baseRefName: undefined };
    }
    return yield* fail(
      "UmbrellaWorktree.resolveBase",
      `${cwd} has no commit to start a worktree from.`,
    );
  });

  const writeManifest = Effect.fn("UmbrellaWorktree.writeManifest")(function* (
    layout: UmbrellaWorktreeLayout,
  ) {
    const { path: worktreePath, ...manifest } = layout;
    yield* fileSystem.writeFileString(
      umbrellaWorktreeManifestPath(path, worktreePath),
      yield* encodeUmbrellaWorktreeManifest({ version: 1, ...manifest }),
    );
  });

  const create = Effect.fn("UmbrellaWorktree.create")(function* (
    input: CreateUmbrellaWorktreeInput,
  ) {
    const umbrellaRoot = path.resolve(input.umbrellaRoot);
    if ((yield* git.repositoryRoot(umbrellaRoot).pipe(Effect.orElseSucceed(() => null))) === null) {
      return yield* fail(
        "UmbrellaWorktree.create",
        `Umbrella worktrees need the umbrella folder ${umbrellaRoot} to be a Git repository.`,
      );
    }
    const memberPaths = umbrellaWorktreeMemberPaths(
      input.members.map((member) => member.relativePath),
    );
    const sources = [umbrellaRoot, ...input.members.map((member) => member.path)];
    let branch = input.branch;
    if (input.flattenOnConflict) {
      const parts = branch.split("/");
      const prefixes = parts.slice(1).map((_, depth) => parts.slice(0, depth + 1).join("/"));
      for (const cwd of sources) {
        const names = yield* git
          .listLocalBranchNames(cwd)
          .pipe(Effect.orElseSucceed((): string[] => []));
        if (names.some((name) => prefixes.includes(name))) {
          branch = branch.replaceAll("/", "-");
          break;
        }
      }
    }

    // Created pieces, removed again if a later step fails or the launch is cancelled.
    const created: Array<{ readonly cwd: string; readonly path: string }> = [];
    let folder: string | null = null;
    let manifestWritten = false;
    const rollback = Effect.gen(function* () {
      for (const piece of created.toReversed()) {
        yield* git
          .removeWorktree({ cwd: piece.cwd, path: piece.path, force: true })
          .pipe(
            Effect.andThen(git.deleteLocalBranch({ cwd: piece.cwd, refName: branch, force: true })),
            Effect.ignoreCause({ log: true }),
          );
      }
      if (folder !== null && manifestWritten) {
        yield* fileSystem.remove(umbrellaWorktreeManifestPath(path, folder)).pipe(Effect.ignore);
        yield* fileSystem.realPath(folder).pipe(
          Effect.orElseSucceed(() => folder!),
          Effect.flatMap(index.forgetWorktree),
        );
      }
    });

    const build = Effect.gen(function* () {
      const base = yield* resolveBase(umbrellaRoot, input.baseRef, input.startFromOrigin);
      const worktree = yield* git.createWorktree(
        {
          cwd: umbrellaRoot,
          refName: base.startRef,
          newRefName: branch,
          ...(base.baseRefName === undefined ? {} : { baseRefName: base.baseRefName }),
          path: null,
        },
        {
          submodules: input.submodules,
          progress: {
            onWorktreeClaimed: (claimed) =>
              Effect.sync(() => {
                folder = claimed;
                created.push({ cwd: umbrellaRoot, path: claimed });
              }),
          },
        },
      );
      const threadFolder = worktree.worktree.path;
      folder = threadFolder;
      if (!created.some((piece) => piece.path === threadFolder)) {
        created.push({ cwd: umbrellaRoot, path: threadFolder });
      }
      const layout: UmbrellaWorktreeLayout = {
        path: threadFolder,
        umbrellaRoot,
        members: input.members.map((member, index) => ({
          source: path.resolve(member.path),
          path: memberPaths[index]!,
        })),
      };
      // Written first, so status and checkpoints of the root worktree leave members out from the start.
      yield* writeManifest(layout);
      manifestWritten = true;
      yield* local(registerUmbrellaWorktree(layout));
      yield* Effect.forEach(
        layout.members,
        (member) =>
          Effect.gen(function* () {
            const target = joinUmbrellaRelative(path, threadFolder, member.path);
            yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
            const base = yield* resolveBase(member.source, input.baseRef, input.startFromOrigin);
            yield* git.createWorktree(
              {
                cwd: member.source,
                refName: base.startRef,
                newRefName: branch,
                ...(base.baseRefName === undefined ? {} : { baseRefName: base.baseRefName }),
                path: target,
              },
              {
                submodules: input.submodules,
                progress: {
                  onWorktreeClaimed: (claimed) =>
                    Effect.sync(() => {
                      created.push({ cwd: member.source, path: claimed });
                    }),
                },
              },
            );
            if (!created.some((piece) => piece.path === target)) {
              created.push({ cwd: member.source, path: target });
            }
          }).pipe(
            Effect.mapError((cause) =>
              cause._tag === "UmbrellaWorktreeError"
                ? cause
                : fail(
                    "UmbrellaWorktree.create",
                    `Could not create the worktree of ${member.path}: ${errorDetail(cause)}`,
                    cause,
                  ),
            ),
          ),
        { concurrency: 4, discard: true },
      );
      // Members' worktrees exist now, so their real paths register.
      yield* local(registerUmbrellaWorktree(layout));
      return { path: threadFolder, branch };
    });

    return yield* build.pipe(
      Effect.mapError((cause) =>
        cause._tag === "UmbrellaWorktreeError"
          ? cause
          : fail("UmbrellaWorktree.create", errorDetail(cause), cause),
      ),
      Effect.onError(() => Effect.uninterruptible(rollback)),
    );
  });

  /**
   * Removes every repository's worktree and the folder. Each branch named by `deleteBranch` goes
   * too. Storage cleanup keeps the manifest, so the next turn can recreate the same layout.
   */
  const remove = Effect.fn("UmbrellaWorktree.remove")(function* (input: {
    readonly worktreePath: string;
    readonly force: boolean;
    readonly deleteBranch?: string;
    readonly keepManifest?: boolean;
  }) {
    const layout = yield* local(readUmbrellaWorktree(input.worktreePath));
    if (layout === null) return false;
    const registeredPath = yield* fileSystem
      .realPath(layout.path)
      .pipe(Effect.orElseSucceed(() => layout.path));
    const failures: Array<string> = [];
    const [root, ...members] = umbrellaWorktreeRepositories(path, layout);
    // Untraced: the removal's span covers each repository.
    const removeRepository = Effect.fnUntraced(
      function* (repository: UmbrellaWorktreeRepository) {
        if (yield* exists(repository.cwd)) {
          yield* git.removeWorktree({
            cwd: repository.source,
            path: repository.cwd,
            force: input.force,
          });
        } else {
          yield* git.pruneWorktrees({ cwd: repository.source });
        }
        if (input.deleteBranch !== undefined) {
          yield* git
            .deleteLocalBranch({
              cwd: repository.source,
              refName: input.deleteBranch,
              force: true,
            })
            .pipe(Effect.ignoreCause({ log: true }));
        }
      },
      (effect, repository) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              failures.push(
                `${repository.relativePath || "the umbrella folder"}: ${errorDetail(Cause.squash(cause))}`,
              );
            }),
          ),
        ),
    );
    // Members first: removing the root's worktree would delete the members inside it.
    for (const member of members.toSorted(
      (left, right) => right.relativePath.length - left.relativePath.length,
    )) {
      yield* removeRepository(member);
    }
    if (failures.length === 0) yield* removeRepository(root!);
    if (failures.length > 0) {
      return yield* fail(
        "UmbrellaWorktree.remove",
        `Could not remove the worktree of ${failures.join("; ")}.`,
      );
    }
    if (input.keepManifest !== true) {
      yield* fileSystem.remove(umbrellaWorktreeManifestPath(path, layout.path)).pipe(Effect.ignore);
      yield* index.forgetWorktree(registeredPath);
    }
    return true;
  });

  /**
   * Recreates whatever part of an umbrella worktree is missing, from `branch` in each
   * repository. Returns false when the folder is not an umbrella worktree.
   */
  const restoreMissing = Effect.fn("UmbrellaWorktree.restoreMissing")(function* (input: {
    readonly worktreePath: string;
    readonly branch: string;
  }) {
    const layout = yield* local(readUmbrellaWorktree(input.worktreePath));
    if (layout === null) return false;
    const hasCheckout = (cwd: string) =>
      fileSystem.exists(path.join(cwd, ".git")).pipe(Effect.orElseSucceed(() => false));
    const isEmptyOrMissing = (cwd: string) =>
      fileSystem.readDirectory(cwd).pipe(
        Effect.map((entries) => entries.length === 0),
        Effect.orElseSucceed(() => true),
      );
    for (const repository of umbrellaWorktreeRepositories(path, layout)) {
      if (yield* hasCheckout(repository.cwd)) continue;
      if (!(yield* isEmptyOrMissing(repository.cwd))) {
        return yield* fail(
          "UmbrellaWorktree.restoreMissing",
          `${repository.cwd} is no longer a checkout but still holds files, so it was left alone.`,
        );
      }
      yield* fileSystem.remove(repository.cwd, { recursive: true }).pipe(Effect.ignore);
      yield* fileSystem.makeDirectory(path.dirname(repository.cwd), { recursive: true });
      yield* Effect.logWarning("recreating a missing umbrella worktree checkout", {
        worktreePath: layout.path,
        repository: repository.relativePath || ".",
        branch: input.branch,
      });
      yield* local(
        recreateBranchWorktree({
          cwd: repository.source,
          worktreePath: repository.cwd,
          branch: input.branch,
        }),
      );
    }
    yield* local(registerUmbrellaWorktree(layout));
    return true;
  });

  /** Renames the thread branch in the folder and, in an umbrella worktree, every member to the same name. */
  const renameBranch = Effect.fn("UmbrellaWorktree.renameBranch")(function* (
    input: Parameters<typeof git.renameBranch>[0],
  ) {
    const renamed = yield* git.renameBranch(input);
    const layout = yield* local(readUmbrellaWorktree(input.cwd));
    const members = layout === null ? [] : umbrellaWorktreeRepositories(path, layout).slice(1);
    for (const repository of members) {
      yield* git
        .renameBranch({
          cwd: repository.cwd,
          oldBranch: input.oldBranch,
          newBranch: renamed.branch,
          exactName: true,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("umbrella member kept its temporary branch name", {
              repository: repository.relativePath,
              branch: input.oldBranch,
              cause,
            }),
          ),
        );
    }
    return renamed;
  });

  return {
    /** The umbrella worktree at this folder, or null when it is not one. */
    read: (worktreePath: string) => local(readUmbrellaWorktree(worktreePath)),
    create,
    remove,
    restoreMissing,
    renameBranch,
  };
});
