import { scopedProjectKey, scopeProjectRef } from "../environment/scoped.ts";
import {
  repositoryGroupingDisplayNameOf,
  repositoryGroupingKeyOf,
  type EnvironmentId,
  type ProjectTrackedFolder,
  type ScopedProjectRef,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";

import type { EnvironmentProject } from "./models.ts";
import { normalizeProjectPathForComparison } from "./projects.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

const SCRATCH_PROJECT_SCOPE_KEY = "\0no-project";

export interface ProjectGroupingSettings {
  readonly sidebarProjectGroupingMode: SidebarProjectGroupingMode;
  readonly sidebarProjectGroupingOverrides: Record<string, SidebarProjectGroupingMode>;
}

export type ProjectGroupingMode = SidebarProjectGroupingMode;

export function selectProjectGroupingSettings(settings: ClientSettings): ProjectGroupingSettings {
  return {
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  };
}

function uniqueNonEmptyValues(values: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function deriveRepositoryRelativeProjectPath(
  project: Pick<EnvironmentProject, "workspaceRoot" | "repositoryIdentity">,
): string | null {
  const rootPath = project.repositoryIdentity?.rootPath?.trim();
  if (!rootPath) {
    return null;
  }

  const normalizedProjectPath = normalizeProjectPathForComparison(project.workspaceRoot);
  const normalizedRootPath = normalizeProjectPathForComparison(rootPath);
  if (normalizedProjectPath.length === 0 || normalizedRootPath.length === 0) {
    return null;
  }

  if (normalizedProjectPath === normalizedRootPath) {
    return "";
  }

  const separator = normalizedRootPath.includes("\\") ? "\\" : "/";
  const rootPrefix = `${normalizedRootPath}${separator}`;
  if (!normalizedProjectPath.startsWith(rootPrefix)) {
    return null;
  }

  return normalizedProjectPath.slice(rootPrefix.length).replaceAll("\\", "/");
}

/** The project's workspace root is its repository's git top-level, not a sub-folder. */
export function isRepositoryRootProject(
  project: Pick<EnvironmentProject, "workspaceRoot" | "repositoryIdentity">,
): boolean {
  return deriveRepositoryRelativeProjectPath(project) === "";
}

/** A group's default checkout for new threads: its repository root, else its first member. */
export function selectGroupDefaultProject<
  TProject extends Pick<EnvironmentProject, "workspaceRoot" | "repositoryIdentity">,
>(projects: ReadonlyArray<TProject>): TProject | undefined {
  return projects.find(isRepositoryRootProject) ?? projects[0];
}

export function derivePhysicalProjectKeyFromPath(environmentId: string, cwd: string): string {
  return `${environmentId}:${normalizeProjectPathForComparison(cwd)}`;
}

export function derivePhysicalProjectKey(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
): string {
  return derivePhysicalProjectKeyFromPath(project.environmentId, project.workspaceRoot);
}

function deriveProjectGroupingOverrideKey(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
): string {
  return derivePhysicalProjectKey(project);
}

export function getProjectOrderKey(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
): string {
  return derivePhysicalProjectKey(project);
}

function resolveProjectGroupingMode(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
  settings: ProjectGroupingSettings,
): SidebarProjectGroupingMode {
  return (
    settings.sidebarProjectGroupingOverrides?.[deriveProjectGroupingOverrideKey(project)] ??
    settings.sidebarProjectGroupingMode
  );
}

function deriveRepositoryScopedKey(
  project: Pick<EnvironmentProject, "workspaceRoot" | "repositoryIdentity">,
  groupingMode: SidebarProjectGroupingMode,
): string | null {
  const canonicalKey = project.repositoryIdentity
    ? repositoryGroupingKeyOf(project.repositoryIdentity)
    : null;
  // A NUL reserves the scratch key namespace outside valid repository identities.
  if (!canonicalKey || canonicalKey.includes("\0")) {
    return null;
  }

  if (groupingMode === "repository") {
    return canonicalKey;
  }

  const relativeProjectPath = deriveRepositoryRelativeProjectPath(project);
  if (relativeProjectPath === null) {
    return canonicalKey;
  }

  return relativeProjectPath.length === 0
    ? canonicalKey
    : `${canonicalKey}::${relativeProjectPath}`;
}

function deriveLogicalProjectKey(
  project: Pick<
    EnvironmentProject,
    "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity" | "isScratch"
  >,
  options?: {
    readonly groupingMode?: SidebarProjectGroupingMode;
    readonly groupScratchProjects?: boolean;
  },
): string {
  if (options?.groupScratchProjects && project.isScratch) return SCRATCH_PROJECT_SCOPE_KEY;
  const groupingMode = options?.groupingMode ?? "repository";
  if (groupingMode === "separate") {
    return derivePhysicalProjectKey(project);
  }

  return (
    deriveRepositoryScopedKey(project, groupingMode) ??
    derivePhysicalProjectKey(project) ??
    scopedProjectKey(scopeProjectRef(project.environmentId, project.id))
  );
}

export function deriveLogicalProjectKeyFromSettings(
  project: Pick<
    EnvironmentProject,
    "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity" | "isScratch"
  >,
  settings: ProjectGroupingSettings,
  options?: { readonly groupScratchProjects?: boolean },
): string {
  return deriveLogicalProjectKey(project, {
    groupingMode: resolveProjectGroupingMode(project, settings),
    groupScratchProjects: options?.groupScratchProjects ?? false,
  });
}

/** The checkout a new thread in `project`'s group starts in on its environment: the group's root. */
export function resolveGroupDefaultProject<TProject extends EnvironmentProject>(
  project: TProject,
  projects: ReadonlyArray<TProject>,
  settings: ProjectGroupingSettings,
): TProject {
  const groupKey = deriveLogicalProjectKeyFromSettings(project, settings);
  return (
    projects.find(
      (candidate) =>
        candidate.environmentId === project.environmentId &&
        isRepositoryRootProject(candidate) &&
        deriveLogicalProjectKeyFromSettings(candidate, settings) === groupKey,
    ) ?? project
  );
}

export function resolveScratchProjectScopeKey(
  key: string | null,
  projects: ReadonlyArray<
    Pick<
      EnvironmentProject,
      "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity" | "isScratch"
    >
  >,
  settings: ProjectGroupingSettings = {
    sidebarProjectGroupingMode: "repository",
    sidebarProjectGroupingOverrides: {},
  },
): string | null {
  if (key === null || key === SCRATCH_PROJECT_SCOPE_KEY) return key;
  if (
    projects.some(
      (project) =>
        deriveLogicalProjectKeyFromSettings(project, settings, { groupScratchProjects: true }) ===
        key,
    )
  ) {
    return key;
  }
  return projects.some((project) => {
    if (!project.isScratch) return false;
    const mode = resolveProjectGroupingMode(project, settings);
    return (
      derivePhysicalProjectKey(project) === key ||
      (mode !== "separate" && deriveRepositoryScopedKey(project, mode) === key)
    );
  })
    ? SCRATCH_PROJECT_SCOPE_KEY
    : key;
}

export function deriveProjectGroupLabel(input: {
  readonly groupKey: string;
  readonly representative: Pick<EnvironmentProject, "title" | "repositoryIdentity">;
  readonly members: ReadonlyArray<
    Pick<EnvironmentProject, "title" | "hasCustomTitle" | "repositoryIdentity">
  >;
}): string {
  const sharedTitles = uniqueNonEmptyValues(input.members.map((member) => member.title));
  const sharedDisplayNames = uniqueNonEmptyValues(
    input.members.map((member) =>
      member.repositoryIdentity ? repositoryGroupingDisplayNameOf(member.repositoryIdentity) : null,
    ),
  );
  const sharedRepositoryNames = uniqueNonEmptyValues(
    input.members.map((member) => member.repositoryIdentity?.name),
  );
  const sharedTitle = sharedTitles[0];
  if (
    sharedTitles.length === 1 &&
    sharedTitle !== undefined &&
    (input.members.some((member) => member.hasCustomTitle === true) ||
      (!sharedDisplayNames.includes(sharedTitle) && !sharedRepositoryNames.includes(sharedTitle)))
  ) {
    return sharedTitle;
  }
  if (sharedDisplayNames.length === 1) {
    return sharedDisplayNames[0]!;
  }

  if (sharedRepositoryNames.length === 1) {
    return sharedRepositoryNames[0]!;
  }

  // A whole-repository group is named for the repository, not one member's folder:
  // clones can disagree on its casing. A subfolder group keeps its own title.
  const representativeIdentity = input.representative.repositoryIdentity;
  if (
    representativeIdentity &&
    input.groupKey === repositoryGroupingKeyOf(representativeIdentity)
  ) {
    return (
      repositoryGroupingDisplayNameOf(representativeIdentity) ??
      representativeIdentity.name ??
      input.representative.title
    );
  }
  return input.representative.title;
}

type CoveredFolderCandidate = Pick<
  EnvironmentProject,
  "environmentId" | "workspaceRoot" | "repositoryIdentity" | "isScratch"
>;

/**
 * How `project` is a folder that a project on `environmentId` covers: the same folder on that
 * environment, or the same repository on any environment.
 */
function coveredFolderMatch(
  folder: Pick<ProjectTrackedFolder, "path" | "repositoryIdentity">,
  environmentId: EnvironmentId,
  project: CoveredFolderCandidate,
): "folder" | "repository" | null {
  if (project.isScratch) return null;
  if (
    project.environmentId === environmentId &&
    normalizeProjectPathForComparison(project.workspaceRoot) ===
      normalizeProjectPathForComparison(folder.path)
  ) {
    return "folder";
  }
  return folder.repositoryIdentity &&
    project.repositoryIdentity &&
    repositoryGroupingKeyOf(folder.repositoryIdentity) ===
      repositoryGroupingKeyOf(project.repositoryIdentity)
    ? "repository"
    : null;
}

/** The project of a folder a project on `environmentId` covers, preferring the one in that folder. */
export function findCoveredFolderProject<TProject extends CoveredFolderCandidate>(
  folder: Pick<ProjectTrackedFolder, "path" | "repositoryIdentity">,
  environmentId: EnvironmentId,
  projects: ReadonlyArray<TProject>,
): TProject | undefined {
  return (
    projects.find((project) => coveredFolderMatch(folder, environmentId, project) === "folder") ??
    projects.find((project) => coveredFolderMatch(folder, environmentId, project) === "repository")
  );
}

/** A project covering other folders: the repositories inside it, or ones someone added. */
export function isCoveringProject(project: Pick<EnvironmentProject, "trackedFolders">): boolean {
  return (project.trackedFolders?.length ?? 0) > 0;
}

export interface ProjectGroupMember<TProject extends EnvironmentProject = EnvironmentProject> {
  readonly physicalProjectKey: string;
  readonly project: TProject;
}

export interface ProjectGroup<TProject extends EnvironmentProject = EnvironmentProject> {
  readonly key: string;
  readonly label: string;
  readonly representative: TProject;
  readonly members: ReadonlyArray<ProjectGroupMember<TProject>>;
  /** Includes the projects of `folded` groups, whose threads show with this group's. */
  readonly memberProjectRefs: ReadonlyArray<ScopedProjectRef>;
  /** Groups folded in because a project here covers their folder, with that folder's name. */
  readonly folded: ReadonlyArray<FoldedProjectGroup<TProject>>;
  /** Clients write every member together. When members still disagree, the project stays visible. */
  readonly pinned: boolean;
  readonly archived: boolean;
}

export interface FoldedProjectGroup<
  TProject extends EnvironmentProject = EnvironmentProject,
> extends ProjectGroup<TProject> {
  readonly folderName: string;
}

/** The groups a project picker offers: archived groups left out, pinned ones first. */
export function pickableProjectGroups<
  TGroup extends { readonly pinned: boolean; readonly archived: boolean },
>(groups: ReadonlyArray<TGroup>): TGroup[] {
  const open = groups.filter((group) => !group.archived);
  return [...open.filter((group) => group.pinned), ...open.filter((group) => !group.pinned)];
}

export function isPickableProjectMember(member: Pick<EnvironmentProject, "archivedAt">): boolean {
  return member.archivedAt == null;
}

function projectFreshnessTime(project: EnvironmentProject): number {
  const updatedAtTime = Date.parse(project.updatedAt);
  if (Number.isFinite(updatedAtTime)) {
    return updatedAtTime;
  }
  const createdAtTime = Date.parse(project.createdAt);
  return Number.isFinite(createdAtTime) ? createdAtTime : 0;
}

function shouldReplacePhysicalProjectWinner<TProject extends EnvironmentProject>(
  existing: TProject,
  candidate: TProject,
): boolean {
  const freshnessDelta = projectFreshnessTime(candidate) - projectFreshnessTime(existing);
  return freshnessDelta > 0 || (freshnessDelta === 0 && candidate.id > existing.id);
}

function selectProjectIdentitySource<TProject extends EnvironmentProject>(
  projects: ReadonlyArray<TProject>,
  winner: TProject,
): TProject {
  if (winner.repositoryIdentity !== null) {
    return winner;
  }

  let freshestIdentifiedProject: TProject | null = null;
  for (const project of projects) {
    if (project.repositoryIdentity === null) {
      continue;
    }
    if (
      freshestIdentifiedProject === null ||
      shouldReplacePhysicalProjectWinner(freshestIdentifiedProject, project)
    ) {
      freshestIdentifiedProject = project;
    }
  }
  return freshestIdentifiedProject ?? winner;
}

export function buildProjectGroups<TProject extends EnvironmentProject>(
  input: {
    readonly projects: ReadonlyArray<TProject>;
    readonly settings: ProjectGroupingSettings;
    readonly preferredEnvironmentId?: EnvironmentId | null;
    readonly groupScratchProjects?: boolean;
    /** Fold each group whose folder another group's project covers into that group. */
    readonly foldCoveredProjects?: boolean;
  },
  resolve: MFunctionType = mFallback,
): ReadonlyArray<ProjectGroup<TProject>> {
  const projectsByPhysicalKey = new Map<string, TProject[]>();
  for (const project of input.projects) {
    const physicalProjectKey = derivePhysicalProjectKey(project);
    const existing = projectsByPhysicalKey.get(physicalProjectKey);
    if (existing) {
      existing.push(project);
    } else {
      projectsByPhysicalKey.set(physicalProjectKey, [project]);
    }
  }

  const logicalKeyByPhysicalKey = new Map<string, string>();
  const groupedMembers = new Map<string, ProjectGroupMember<TProject>[]>();
  for (const [physicalProjectKey, physicalProjects] of projectsByPhysicalKey) {
    const winner = physicalProjects.reduce((current, candidate) =>
      shouldReplacePhysicalProjectWinner(current, candidate) ? candidate : current,
    );
    const identitySource = selectProjectIdentitySource(physicalProjects, winner);
    const logicalKey = deriveLogicalProjectKey(identitySource, {
      groupingMode: resolveProjectGroupingMode(winner, input.settings),
      groupScratchProjects: input.groupScratchProjects ?? false,
    });
    logicalKeyByPhysicalKey.set(physicalProjectKey, logicalKey);
    const member = { physicalProjectKey, project: winner };
    const existing = groupedMembers.get(logicalKey);
    if (existing) {
      existing.push(member);
    } else {
      groupedMembers.set(logicalKey, [member]);
    }
  }

  const projectRefsByLogicalKey = new Map<string, ScopedProjectRef[]>();
  const seenProjectRefs = new Set<string>();
  for (const project of input.projects) {
    const physicalProjectKey = derivePhysicalProjectKey(project);
    const logicalKey =
      logicalKeyByPhysicalKey.get(physicalProjectKey) ??
      deriveLogicalProjectKeyFromSettings(project, input.settings, {
        groupScratchProjects: input.groupScratchProjects ?? false,
      });
    const projectRefKey = scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
    if (seenProjectRefs.has(projectRefKey)) continue;
    seenProjectRefs.add(projectRefKey);
    const projectRef = scopeProjectRef(project.environmentId, project.id);
    const existing = projectRefsByLogicalKey.get(logicalKey);
    if (existing) {
      existing.push(projectRef);
    } else {
      projectRefsByLogicalKey.set(logicalKey, [projectRef]);
    }
  }

  const preferredEnvironmentId = input.preferredEnvironmentId ?? null;
  const groups = Array.from(groupedMembers, ([key, members]): ProjectGroup<TProject> => {
    const projects = members.map((member) => member.project);
    const representative =
      (preferredEnvironmentId
        ? selectGroupDefaultProject(
            projects.filter((project) => project.environmentId === preferredEnvironmentId),
          )
        : undefined) ?? selectGroupDefaultProject(projects)!;
    return {
      key,
      label:
        input.groupScratchProjects && representative.isScratch
          ? resolve(msg("No project"))
          : members.length > 1
            ? deriveProjectGroupLabel({
                groupKey: key,
                representative,
                members: members.map((member) => member.project),
              })
            : representative.title,
      representative,
      members,
      memberProjectRefs: projectRefsByLogicalKey.get(key) ?? [],
      folded: [],
      pinned: members.some((member) => member.project.pinnedAt != null),
      archived: !members.some(({ project }) => isPickableProjectMember(project)),
    };
  });
  return input.foldCoveredProjects ? foldCoveredProjectGroups(groups, input.settings) : groups;
}

/**
 * Moves each group whose project is a folder another open group's project covers into that
 * group, matching by folder before repository. A covered folder's project may cover folders
 * itself, so a fold follows the chain to its end; groups covering each other stay apart.
 */
function foldCoveredProjectGroups<TProject extends EnvironmentProject>(
  groups: ReadonlyArray<ProjectGroup<TProject>>,
  settings: ProjectGroupingSettings,
): ReadonlyArray<ProjectGroup<TProject>> {
  const covered = groups.flatMap((group) =>
    group.archived
      ? []
      : group.members.flatMap(({ project }) =>
          (project.trackedFolders ?? []).map((folder) => ({ group, project, folder })),
        ),
  );
  if (covered.length === 0) return groups;
  const coveredBy = new Map<ProjectGroup<TProject>, (typeof covered)[number]>();
  for (const group of groups) {
    if (resolveProjectGroupingMode(group.representative, settings) === "separate") continue;
    const find = (match: "folder" | "repository") =>
      covered.find(
        (entry) =>
          entry.group !== group &&
          group.members.some(
            ({ project }) =>
              coveredFolderMatch(entry.folder, entry.project.environmentId, project) === match,
          ),
      );
    const entry = find("folder") ?? find("repository");
    if (entry) coveredBy.set(group, entry);
  }
  const foldTarget = (group: ProjectGroup<TProject>) => {
    const seen = new Set([group]);
    let target = coveredBy.get(group)?.group;
    while (target !== undefined && coveredBy.has(target)) {
      if (seen.has(target)) return undefined;
      seen.add(target);
      target = coveredBy.get(target)!.group;
    }
    return target;
  };
  const foldedInto = new Map<ProjectGroup<TProject>, FoldedProjectGroup<TProject>[]>();
  for (const [group, entry] of coveredBy) {
    const target = foldTarget(group);
    if (target === undefined) continue;
    const folded = foldedInto.get(target) ?? [];
    folded.push({ ...group, folderName: entry.folder.name });
    foldedInto.set(target, folded);
  }
  return groups.flatMap((group) => {
    if (foldTarget(group) !== undefined) return [];
    const folded = foldedInto.get(group);
    return folded === undefined
      ? [group]
      : [
          {
            ...group,
            memberProjectRefs: [
              ...group.memberProjectRefs,
              ...folded.flatMap((entry) => entry.memberProjectRefs),
            ],
            folded,
          },
        ];
  });
}

export function sortProjectsByGroupOrder<
  TProject extends { readonly id: string; readonly environmentId: string },
>(
  projects: ReadonlyArray<TProject>,
  groups: ReadonlyArray<{
    readonly memberProjectRefs: ReadonlyArray<ScopedProjectRef>;
    readonly pinned: boolean;
    readonly archived: boolean;
  }>,
): TProject[] {
  const rankByProject = new Map<string, number>();
  pickableProjectGroups(groups).forEach((group, rank) => {
    for (const ref of group.memberProjectRefs) {
      const key = `${ref.environmentId}\0${ref.projectId}`;
      if (!rankByProject.has(key)) rankByProject.set(key, rank);
    }
  });
  const rankOf = (project: TProject) =>
    rankByProject.get(`${project.environmentId}\0${project.id}`) ?? groups.length;
  return [...projects].sort((left, right) => rankOf(left) - rankOf(right));
}
