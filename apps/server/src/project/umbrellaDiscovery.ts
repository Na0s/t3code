// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

const DEFAULT_MAX_DEPTH = 3;
// Bounds a scan of a huge non-umbrella folder; a client folder holds far fewer directories.
const DEFAULT_MAX_DIRECTORIES = 1_000;
const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules"]);

export interface NestedRepositoryDiscoveryOptions {
  readonly maxDepth?: number;
  readonly maxDirectories?: number;
}

const readDirectoryEntries = (directory: string) =>
  Effect.promise(() => NodeFSP.readdir(directory, { withFileTypes: true }).catch(() => []));

/**
 * Git checkouts under `root`, at most `maxDepth` levels down. A checkout's own folders are not
 * searched, and linked worktrees and submodules (a `.git` file) are skipped: they belong to
 * another repository. Hidden folders, `node_modules`, and symlinks are never entered.
 */
export const discoverNestedRepositories = Effect.fn("umbrellaDiscovery.discoverNestedRepositories")(
  function* (root: string, options: NestedRepositoryDiscoveryOptions = {}) {
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    let budget = options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
    const found: string[] = [];
    let frontier = [{ directory: root, entries: yield* readDirectoryEntries(root) }];
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const next: typeof frontier = [];
      for (const { directory, entries } of frontier) {
        for (const entry of entries) {
          if (
            !entry.isDirectory() ||
            entry.name.startsWith(".") ||
            SKIPPED_DIRECTORY_NAMES.has(entry.name)
          ) {
            continue;
          }
          if (budget-- <= 0) return found.toSorted();
          const child = NodePath.join(directory, entry.name);
          const childEntries = yield* readDirectoryEntries(child);
          const gitEntry = childEntries.find((candidate) => candidate.name === ".git");
          if (gitEntry?.isDirectory()) found.push(child);
          else if (gitEntry === undefined && depth < maxDepth) {
            next.push({ directory: child, entries: childEntries });
          }
        }
      }
      frontier = next;
    }
    return found.toSorted();
  },
);
