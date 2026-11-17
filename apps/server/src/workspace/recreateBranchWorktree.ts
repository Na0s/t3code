import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";

export class WorktreeRecreateNoBaseError extends Schema.TaggedError<WorktreeRecreateNoBaseError>()(
  "WorktreeRecreateNoBaseError",
  { worktreePath: Schema.String, branch: Schema.String },
) {
  override get message(): string {
    return `Could not recreate branch '${this.branch}' at ${this.worktreePath}: the project workspace has no commit to start it from.`;
  }
}

const resolveRecreateBase = Effect.fn("recreateBranchWorktree.resolveRecreateBase")(function* (
  cwd: string,
  remoteName: string | null,
) {
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  // Recovery can follow an external checkout, before the status cache expires.
  yield* gitWorkflow.invalidateLocalStatus(cwd);
  const { refName: currentBranch } = yield* gitWorkflow.localStatus({ cwd });
  if (currentBranch !== null) {
    const refName = `refs/heads/${currentBranch}`;
    return { refName, baseRefName: refName };
  }
  const remoteHead = `refs/remotes/${remoteName}/HEAD`;
  if (remoteName !== null && (yield* gitWorkflow.hasCommit({ cwd, refName: remoteHead }))) {
    const { commitSha } = yield* gitWorkflow.resolveRemoteTrackingCommit({
      cwd,
      refName: "HEAD",
      fallbackRemoteName: remoteName,
    });
    // Start from the commit so the thread branch does not track the default branch.
    return { refName: commitSha, baseRefName: remoteHead };
  }
  if (yield* gitWorkflow.hasCommit({ cwd, refName: "HEAD" })) {
    return { refName: "HEAD", baseRefName: undefined };
  }
  return null;
});

/** Checks `branch` out at `worktreePath` again: the local branch, else its pushed copy, else a new branch from the checkout. */
export const recreateBranchWorktree = Effect.fn("recreateBranchWorktree")(function* (input: {
  readonly cwd: string;
  readonly worktreePath: string;
  readonly branch: string;
}) {
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const { cwd, worktreePath, branch } = input;
  yield* gitWorkflow.pruneWorktrees({ cwd });
  const localBranchNames = yield* gitWorkflow.listLocalBranchNames(cwd);
  if (localBranchNames.includes(branch)) {
    yield* gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath });
    return;
  }
  const remoteName = yield* gitWorkflow
    .resolvePrimaryRemoteName(cwd)
    .pipe(Effect.orElseSucceed(() => null));
  // Push keeps the tracking ref current, so recovery reads it without fetching.
  const pushedRef = remoteName === null ? null : `refs/remotes/${remoteName}/${branch}`;
  if (pushedRef !== null && (yield* gitWorkflow.hasCommit({ cwd, refName: pushedRef }))) {
    yield* gitWorkflow.createWorktree({
      cwd,
      refName: pushedRef,
      newRefName: branch,
      path: worktreePath,
    });
    return;
  }
  const base = yield* resolveRecreateBase(cwd, remoteName);
  if (base === null) {
    return yield* new WorktreeRecreateNoBaseError({ worktreePath, branch });
  }
  yield* gitWorkflow.createWorktree({
    cwd,
    refName: base.refName,
    newRefName: branch,
    ...(base.baseRefName === undefined ? {} : { baseRefName: base.baseRefName }),
    path: worktreePath,
  });
});
