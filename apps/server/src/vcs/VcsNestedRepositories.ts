import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * The repositories a project covers inside a checkout of its folder, relative to `worktreeRoot`
 * with `/` separators. Each has its own status, review and commits, so the checkout's own Git views
 * leave them out. Empty where no project layer is provided.
 */
export class VcsNestedRepositories extends Context.Reference<
  (input: {
    readonly cwd: string;
    readonly worktreeRoot: string;
  }) => Effect.Effect<ReadonlyArray<string>>
>("t3/vcs/VcsNestedRepositories", { defaultValue: () => () => Effect.succeed([]) }) {}
