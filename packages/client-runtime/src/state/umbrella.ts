import {
  repositoryGroupingKeyOf,
  type ProjectSettingsOverrides,
  type UmbrellaMember,
} from "@t3tools/contracts";

import { umbrellaWorktreeMemberPaths } from "@t3tools/shared/umbrellaWorktree";

import type { EnvironmentProject } from "./models.ts";
import { normalizeProjectPathForComparison } from "./projects.ts";
import { isUmbrellaProject } from "./projectGrouping.ts";

type UmbrellaProject = Pick<
  EnvironmentProject,
  "environmentId" | "id" | "title" | "workspaceRoot" | "umbrellaMembers"
>;
type UmbrellaOverrides = Pick<
  ProjectSettingsOverrides,
  "umbrellaEnabled" | "umbrellaAdoptedPaths" | "umbrellaExcludedPaths"
>;

/** How a member reads in a list: its path under the umbrella, or its folder name when adopted from outside. */
export function umbrellaMemberLabel(member: Pick<UmbrellaMember, "relativePath">): string {
  return member.relativePath.startsWith("../")
    ? (member.relativePath.split("/").at(-1) ?? member.relativePath)
    : member.relativePath;
}

/**
 * The members as a thread sees them: their own checkouts, or, for a worktree-mode thread, their
 * worktrees inside the thread's folder.
 */
export function umbrellaMembersForThread<
  TMember extends Pick<UmbrellaMember, "path" | "relativePath">,
>(
  members: ReadonlyArray<TMember>,
  worktreePath: string | null | undefined,
): ReadonlyArray<TMember> {
  if (!worktreePath || members.length === 0) return members;
  const root = worktreePath.replace(/[\\/]+$/, "");
  const separator = root.includes("/") || !root.includes("\\") ? "/" : "\\";
  const paths = umbrellaWorktreeMemberPaths(members.map((member) => member.relativePath));
  return members.map((member, index) => ({
    ...member,
    path: `${root}${separator}${paths[index]!.split("/").join(separator)}`,
  }));
}

/**
 * The members a turn's files touch, in member order, each with its folder in the file paths: under
 * the umbrella folder or, for a worktree-mode thread, its folder. A null member with folder "" leads
 * when files sit in the umbrella's own repository, outside every member.
 */
export function umbrellaMembersInFiles<TMember extends Pick<UmbrellaMember, "relativePath">>(
  members: ReadonlyArray<TMember>,
  filePaths: ReadonlyArray<string>,
  worktreeMode: boolean,
): ReadonlyArray<{ readonly member: TMember | null; readonly folder: string }> {
  if (members.length === 0) return [];
  const relativePaths = members.map((member) => member.relativePath);
  const folders = worktreeMode ? umbrellaWorktreeMemberPaths(relativePaths) : relativePaths;
  const prefixes = folders.map((path, index) => ({ prefix: `${path}/`, index }));
  // A member nested in another's folder owns its own files.
  prefixes.sort((left, right) => right.prefix.length - left.prefix.length);
  const touched = new Set<number>();
  let root = false;
  for (const filePath of filePaths) {
    const owner = prefixes.find(({ prefix }) => filePath.startsWith(prefix));
    if (owner === undefined) root = true;
    else touched.add(owner.index);
  }
  return [
    ...(root ? [{ member: null, folder: "" }] : []),
    ...members.flatMap((member, index) =>
      touched.has(index) ? [{ member, folder: folders[index]! }] : [],
    ),
  ];
}

const isAbsolute = (value: string) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);

/** Settings may hold paths relative to the umbrella root; compare them resolved. */
function sameSettingPath(root: string, entry: string, path: string): boolean {
  const resolved = isAbsolute(entry) ? entry : `${root.replace(/[\\/]+$/, "")}/${entry}`;
  return normalizeProjectPathForComparison(resolved) === normalizeProjectPathForComparison(path);
}

function without(root: string, entries: ReadonlyArray<string> | undefined, path: string) {
  return (entries ?? []).filter((entry) => !sameSettingPath(root, entry, path));
}

function withPaths(
  overrides: UmbrellaOverrides | undefined,
  adopted: ReadonlyArray<string>,
  excluded: ReadonlyArray<string>,
): UmbrellaOverrides {
  return {
    ...overrides,
    umbrellaAdoptedPaths: adopted,
    umbrellaExcludedPaths: excluded,
  };
}

/** Turns the umbrella on or off; discovered checkouts wait for this, adopted ones turn it on. */
export function setUmbrellaEnabled(
  overrides: UmbrellaOverrides | undefined,
  enabled: boolean,
): UmbrellaOverrides {
  return { ...overrides, umbrellaEnabled: enabled };
}

/** Adds a checkout, lifting an exclusion that hid it, and turns the umbrella on. */
export function adoptUmbrellaMember(
  umbrella: Pick<UmbrellaProject, "workspaceRoot">,
  overrides: UmbrellaOverrides | undefined,
  path: string,
): UmbrellaOverrides {
  const root = umbrella.workspaceRoot;
  return withPaths(
    setUmbrellaEnabled(overrides, true),
    [...without(root, overrides?.umbrellaAdoptedPaths, path), path],
    without(root, overrides?.umbrellaExcludedPaths, path),
  );
}

/** Drops a member: an adopted one is forgotten, a discovered one is excluded so scans skip it. */
export function removeUmbrellaMember(
  umbrella: Pick<UmbrellaProject, "workspaceRoot">,
  overrides: UmbrellaOverrides | undefined,
  member: Pick<UmbrellaMember, "path" | "source">,
): UmbrellaOverrides {
  const root = umbrella.workspaceRoot;
  const excluded = without(root, overrides?.umbrellaExcludedPaths, member.path);
  return withPaths(
    overrides,
    without(root, overrides?.umbrellaAdoptedPaths, member.path),
    member.source === "nested" ? [...excluded, member.path] : excluded,
  );
}

/** Lets a discovered checkout back in. */
export function restoreUmbrellaMember(
  umbrella: Pick<UmbrellaProject, "workspaceRoot">,
  overrides: UmbrellaOverrides | undefined,
  path: string,
): UmbrellaOverrides {
  return withPaths(
    overrides,
    overrides?.umbrellaAdoptedPaths ?? [],
    without(umbrella.workspaceRoot, overrides?.umbrellaExcludedPaths, path),
  );
}

/**
 * The umbrella a project belongs to as a member, matching how the sidebar folds it: its folder
 * on the umbrella's environment, or else its repository on any environment. Only a folder match
 * is the umbrella's own checkout; a repository match is a separate clone that merely groups there.
 */
export function findUmbrellaMembership<TProject extends UmbrellaProject>(
  project: Pick<
    EnvironmentProject,
    "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity"
  >,
  projects: ReadonlyArray<TProject>,
): {
  readonly umbrella: TProject;
  readonly member: UmbrellaMember;
  readonly match: "folder" | "repository";
} | null {
  const projectPath = normalizeProjectPathForComparison(project.workspaceRoot);
  const repositoryKey = project.repositoryIdentity
    ? repositoryGroupingKeyOf(project.repositoryIdentity)
    : null;
  const umbrellas = projects.filter(
    (umbrella) => !(umbrella.id === project.id && umbrella.environmentId === project.environmentId),
  );
  for (const umbrella of umbrellas) {
    if (umbrella.environmentId !== project.environmentId) continue;
    const member = umbrella.umbrellaMembers?.find(
      (candidate) => normalizeProjectPathForComparison(candidate.path) === projectPath,
    );
    if (member) return { umbrella, member, match: "folder" };
  }
  if (repositoryKey === null) return null;
  for (const umbrella of umbrellas) {
    const member = umbrella.umbrellaMembers?.find(
      (candidate) =>
        candidate.repositoryIdentity &&
        repositoryGroupingKeyOf(candidate.repositoryIdentity) === repositoryKey,
    );
    if (member) return { umbrella, member, match: "repository" };
  }
  return null;
}

/** Umbrellas on the project's environment that could adopt its folder. */
export function umbrellaAdoptionTargets<TProject extends UmbrellaProject>(
  project: Pick<EnvironmentProject, "environmentId" | "id" | "workspaceRoot" | "umbrellaMembers">,
  projects: ReadonlyArray<TProject>,
): ReadonlyArray<TProject> {
  if (isUmbrellaProject(project)) return [];
  const projectPath = normalizeProjectPathForComparison(project.workspaceRoot);
  return projects.filter(
    (umbrella) =>
      umbrella.environmentId === project.environmentId &&
      umbrella.id !== project.id &&
      isUmbrellaProject(umbrella) &&
      !(umbrella.umbrellaMembers ?? []).some(
        (member) => normalizeProjectPathForComparison(member.path) === projectPath,
      ),
  );
}
