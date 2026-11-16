import {
  repositoryGroupingKeyOf,
  type ProjectSettingsOverrides,
  type UmbrellaMember,
} from "@t3tools/contracts";

import type { EnvironmentProject } from "./models.ts";
import { normalizeProjectPathForComparison } from "./projects.ts";
import { isUmbrellaProject } from "./projectGrouping.ts";

type UmbrellaProject = Pick<
  EnvironmentProject,
  "environmentId" | "id" | "title" | "workspaceRoot" | "umbrellaMembers"
>;
type UmbrellaOverrides = Pick<
  ProjectSettingsOverrides,
  "umbrellaAdoptedPaths" | "umbrellaExcludedPaths"
>;

/** How a member reads in a list: its path under the umbrella, or its folder name when adopted from outside. */
export function umbrellaMemberLabel(member: Pick<UmbrellaMember, "relativePath">): string {
  return member.relativePath.startsWith("../")
    ? (member.relativePath.split("/").at(-1) ?? member.relativePath)
    : member.relativePath;
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

/** Adds a checkout, lifting an exclusion that hid it. */
export function adoptUmbrellaMember(
  umbrella: Pick<UmbrellaProject, "workspaceRoot">,
  overrides: UmbrellaOverrides | undefined,
  path: string,
): UmbrellaOverrides {
  const root = umbrella.workspaceRoot;
  return withPaths(
    overrides,
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
 * The umbrella a project belongs to as a member: its folder on the umbrella's environment, or
 * its repository on any environment, matching how the sidebar folds it.
 */
export function findUmbrellaMembership<TProject extends UmbrellaProject>(
  project: Pick<
    EnvironmentProject,
    "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity"
  >,
  projects: ReadonlyArray<TProject>,
): { readonly umbrella: TProject; readonly member: UmbrellaMember } | null {
  const projectPath = normalizeProjectPathForComparison(project.workspaceRoot);
  const repositoryKey = project.repositoryIdentity
    ? repositoryGroupingKeyOf(project.repositoryIdentity)
    : null;
  for (const umbrella of projects) {
    if (umbrella.id === project.id && umbrella.environmentId === project.environmentId) continue;
    for (const member of umbrella.umbrellaMembers ?? []) {
      if (
        umbrella.environmentId === project.environmentId &&
        normalizeProjectPathForComparison(member.path) === projectPath
      ) {
        return { umbrella, member };
      }
      if (
        repositoryKey !== null &&
        member.repositoryIdentity &&
        repositoryGroupingKeyOf(member.repositoryIdentity) === repositoryKey
      ) {
        return { umbrella, member };
      }
    }
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
