// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import type { UmbrellaMember, WorktreeSubmodules } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { umbrellaWorktreeMemberPaths } from "@t3tools/shared/umbrellaWorktree";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { removeEmptyDirectory } from "../vcs/removeEmptyDirectory.ts";
import { UmbrellaMemberIndex } from "../vcs/UmbrellaMemberIndex.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";
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

export interface CreateUmbrellaWorktreeInput {
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
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
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
  const isInside = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  const isLink = (target: string) =>
    fileSystem.readLink(target).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  const present = (target: string) =>
    Effect.zipWith(
      fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false)),
      isLink(target),
      (exists, link) => exists || link,
    );

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

  /**
   * Links each entry of the plain umbrella root that is neither a member nor holds one, walking
   * into folders that hold members. Existing entries are kept, so a recovery only fills gaps.
   */
  const linkSiblings = Effect.fn("UmbrellaWorktree.linkSiblings")(function* (
    layout: UmbrellaWorktreeLayout,
  ) {
    const memberPaths = new Set(layout.members.map((member) => member.path));
    const holdsMember = (relativePath: string) =>
      layout.members.some((member) => member.path.startsWith(`${relativePath}/`));
    const visit = Effect.fnUntraced(function* (
      relativeDirectory: string,
    ): Effect.fn.Return<void, PlatformError.PlatformError> {
      const entries = yield* fileSystem
        .readDirectory(joinUmbrellaRelative(path, layout.umbrellaRoot, relativeDirectory))
        .pipe(Effect.orElseSucceed((): string[] => []));
      for (const name of entries.toSorted()) {
        const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
        if (memberPaths.has(relativePath)) continue;
        const source = joinUmbrellaRelative(path, layout.umbrellaRoot, relativePath);
        const target = joinUmbrellaRelative(path, layout.path, relativePath);
        // A worktree folder set inside the umbrella would otherwise link to itself.
        if (isInside(source, layout.path)) continue;
        if (holdsMember(relativePath)) {
          yield* fileSystem.makeDirectory(target, { recursive: true });
          yield* visit(relativePath);
          continue;
        }
        if (yield* present(target)) continue;
        yield* fileSystem.symlink(source, target).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("could not link an umbrella entry into its worktree", {
              source,
              target,
              cause,
            }),
          ),
        );
      }
    });
    yield* visit("");
  });

  /** A plain folder's own entries are links and folders this module made; files are the agent's. */
  const removePlainFolder = Effect.fn("UmbrellaWorktree.removePlainFolder")(function* (
    folder: string,
    force: boolean,
  ) {
    const visit = Effect.fnUntraced(function* (
      target: string,
    ): Effect.fn.Return<boolean, UmbrellaWorktreeError> {
      if (yield* isLink(target)) {
        yield* fileSystem
          .remove(target)
          .pipe(
            Effect.mapError((cause) =>
              fail("UmbrellaWorktree.remove", `Could not remove ${target}.`, cause),
            ),
          );
        return true;
      }
      const info = yield* fileSystem.stat(target).pipe(Effect.option);
      if (Option.isNone(info)) return true;
      if (info.value.type !== "Directory") {
        if (!force) return false;
        yield* fileSystem
          .remove(target)
          .pipe(
            Effect.mapError((cause) =>
              fail("UmbrellaWorktree.remove", `Could not remove ${target}.`, cause),
            ),
          );
        return true;
      }
      const entries = yield* fileSystem
        .readDirectory(target)
        .pipe(Effect.orElseSucceed((): string[] => []));
      let empty = true;
      for (const name of entries) {
        if (!(yield* visit(path.join(target, name)))) empty = false;
      }
      if (!empty) return false;
      // Files written since the listing keep the folder.
      return yield* removeEmptyDirectory(target).pipe(
        Effect.mapError((cause) =>
          fail("UmbrellaWorktree.remove", `Could not remove ${target}.`, cause),
        ),
      );
    });
    if (!(yield* visit(folder))) {
      return yield* fail(
        "UmbrellaWorktree.remove",
        `${folder} holds files that are not part of any repository; remove it with force to delete them.`,
      );
    }
  });

  const threadFolderFor = Effect.fn("UmbrellaWorktree.threadFolderFor")(function* (
    umbrellaRoot: string,
    branch: string,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed(() => ({ worktreesDirectory: "" })),
    );
    const parent = resolveWorktreesDirectory(
      settings.worktreesDirectory,
      serverConfig.worktreesDir,
      path,
      yield* HostProcess.HomeDirectory,
    );
    if (parent === null) {
      return yield* fail(
        "UmbrellaWorktree.create",
        `The worktree location "${settings.worktreesDirectory}" must be an absolute folder on this machine, not a drive root. Change it in Settings → Worktrees.`,
      );
    }
    // Named as Git worktrees are: by umbrella, then a short branch prefix and a stable hash.
    const root = yield* fileSystem
      .realPath(umbrellaRoot)
      .pipe(Effect.orElseSucceed(() => path.resolve(umbrellaRoot)));
    const hash = NodeCrypto.createHash("sha256").update(`${root}\0${branch}`).digest("hex");
    let prefix = "";
    for (const character of branch.replace(/\//g, "-")) {
      if (Buffer.byteLength(prefix + character) > 23) break;
      prefix += character;
    }
    const basePath = path.join(parent, path.basename(root), `${prefix}-${hash.slice(0, 16)}`);
    let candidate = basePath;
    for (
      let suffix = 2;
      (yield* present(candidate)) ||
      (yield* present(umbrellaWorktreeManifestPath(path, candidate)));
      suffix++
    ) {
      candidate = `${basePath}-${suffix}`;
    }
    return candidate;
  });

  const create = Effect.fn("UmbrellaWorktree.create")(function* (
    input: CreateUmbrellaWorktreeInput,
  ) {
    const umbrellaRoot = path.resolve(input.umbrellaRoot);
    const rootRepository =
      (yield* git.repositoryRoot(umbrellaRoot).pipe(Effect.orElseSucceed(() => null))) !== null;
    const memberPaths = umbrellaWorktreeMemberPaths(
      input.members.map((member) => member.relativePath),
    );
    const sources = [
      ...(rootRepository ? [umbrellaRoot] : []),
      ...input.members.map((member) => member.path),
    ];
    if (sources.length === 0) {
      return yield* fail("UmbrellaWorktree.create", "This umbrella has no repositories.");
    }
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
      if (folder !== null && !rootRepository) {
        yield* fileSystem.remove(folder, { recursive: true }).pipe(Effect.ignore);
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
      if (rootRepository) {
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
        folder = worktree.worktree.path;
        if (!created.some((piece) => piece.path === folder)) {
          created.push({ cwd: umbrellaRoot, path: folder });
        }
      } else {
        folder = yield* threadFolderFor(umbrellaRoot, branch);
        yield* fileSystem.makeDirectory(folder, { recursive: true });
      }
      const threadFolder = folder;
      const layout: UmbrellaWorktreeLayout = {
        path: threadFolder,
        umbrellaRoot,
        rootRepository,
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
      if (!rootRepository) yield* linkSiblings(layout);
      // Members' worktrees exist now, so their real paths register.
      yield* local(registerUmbrellaWorktree(layout));
      return { path: threadFolder, branch, rootRepository };
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
    const repositories = umbrellaWorktreeRepositories(path, layout);
    // Members first: removing the root's worktree would delete the members inside it.
    const members = repositories
      .filter((repository) => repository.relativePath !== "")
      .toSorted((left, right) => right.relativePath.length - left.relativePath.length);
    // Untraced: the removal's span covers each repository.
    const removeRepository = Effect.fnUntraced(
      function* (repository: UmbrellaWorktreeRepository) {
        if (yield* present(repository.cwd)) {
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
    for (const member of members) yield* removeRepository(member);
    if (failures.length > 0) {
      return yield* fail(
        "UmbrellaWorktree.remove",
        `Could not remove the worktree of ${failures.join("; ")}.`,
      );
    }
    const root = repositories.find((repository) => repository.relativePath === "");
    if (root !== undefined) {
      yield* removeRepository(root);
    } else if (yield* present(layout.path)) {
      yield* removePlainFolder(layout.path, input.force);
    }
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
    const folderMissing = !(yield* present(layout.path));
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
    // Links come back only with the folder; one the agent removed stays removed.
    if (!layout.rootRepository && folderMissing) {
      yield* fileSystem.makeDirectory(layout.path, { recursive: true });
      yield* linkSiblings(layout);
    }
    yield* local(registerUmbrellaWorktree(layout));
    return true;
  });

  /** Renames the thread branch in every repository, all to the first repository's resulting name. */
  const renameBranch = Effect.fn("UmbrellaWorktree.renameBranch")(function* (input: {
    readonly worktreePath: string;
    readonly oldBranch: string;
    readonly newBranch: string;
    readonly exactName?: boolean;
  }) {
    const layout = yield* local(readUmbrellaWorktree(input.worktreePath));
    if (layout === null) {
      return yield* fail(
        "UmbrellaWorktree.renameBranch",
        `${input.worktreePath} is not an umbrella worktree.`,
      );
    }
    const [first, ...rest] = umbrellaWorktreeRepositories(path, layout);
    if (first === undefined) return { branch: input.oldBranch };
    const renamed = yield* git.renameBranch({
      cwd: first.cwd,
      oldBranch: input.oldBranch,
      newBranch: input.newBranch,
      ...(input.exactName ? { exactName: true } : {}),
    });
    for (const repository of rest) {
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

  return { create, remove, restoreMissing, renameBranch };
});

export type UmbrellaWorktrees = Effect.Success<typeof makeUmbrellaWorktrees>;
