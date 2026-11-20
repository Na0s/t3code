/** Folder in a worktree-mode umbrella thread that holds members adopted from outside the umbrella. */
const UMBRELLA_WORKTREE_EXTERNAL_FOLDER = "_external";

/**
 * Where each umbrella member sits inside a worktree-mode thread's folder, given members' paths
 * relative to the umbrella root. A member under the root keeps its path; one adopted from outside
 * goes under `_external/<folder name>`, numbered when two share a name.
 */
export function umbrellaWorktreeMemberPaths(
  relativePaths: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const isExternal = (relativePath: string) =>
    relativePath === ".." || relativePath.startsWith("../");
  const taken = new Set(relativePaths.filter((relativePath) => !isExternal(relativePath)));
  return relativePaths.map((relativePath) => {
    if (!isExternal(relativePath)) return relativePath;
    const name =
      relativePath
        .split("/")
        .filter((segment) => segment !== ".." && segment !== "")
        .at(-1) ?? "member";
    let candidate = `${UMBRELLA_WORKTREE_EXTERNAL_FOLDER}/${name}`;
    for (let suffix = 2; taken.has(candidate); suffix++) {
      candidate = `${UMBRELLA_WORKTREE_EXTERNAL_FOLDER}/${name}-${suffix}`;
    }
    taken.add(candidate);
    return candidate;
  });
}
