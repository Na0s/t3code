import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { isUmbrellaProject } from "@t3tools/client-runtime/state/project-grouping";
import { umbrellaMemberLabel } from "@t3tools/client-runtime/state/umbrella";

import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import type { Project } from "../types";
import {
  buildCommandPaletteProjectMetadata,
  buildProjectActionItems,
  type CommandPaletteActionItem,
  type CommandPaletteItemPin,
  type CommandPaletteProject,
  ITEM_ICON_CLASS,
} from "./CommandPalette.logic";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { ProjectFavicon } from "./ProjectFavicon";
import { COMMAND_PALETTE_META_ICON_CLASS, CommandPaletteMetaDot } from "./ThreadCommandSubtitle";

export interface CommandPaletteProjectLocation {
  readonly kind: "local" | "remote";
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
}

const UNKNOWN_PROJECT_LOCATION: CommandPaletteProjectLocation = {
  kind: "remote",
  label: "Remote",
  machine: "server",
};

interface ProjectItemsInput {
  readonly projects: ReadonlyArray<CommandPaletteProject>;
  readonly projectGroupByTargetKey: ReadonlyMap<string, SidebarProjectSnapshot>;
  readonly locationByEnvironmentId: ReadonlyMap<EnvironmentId, CommandPaletteProjectLocation>;
  readonly runProject: (project: CommandPaletteProject) => Promise<void>;
  readonly pin?: (project: CommandPaletteProject) => CommandPaletteItemPin | null;
}

function projectFaviconIcon(project: Project) {
  return <ProjectFavicon project={project} className={ITEM_ICON_CLASS} />;
}

/**
 * Projects as root search results; a grouped project matches on every member. An umbrella is one
 * line with its members' rows indented under it, and both match by name only.
 */
export function buildProjectSearchItems(
  input: ProjectItemsInput & {
    readonly openMemberProject: (project: CommandPaletteProject) => Promise<void>;
  },
) {
  const membersOf = (project: CommandPaletteProject) =>
    input.projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`)?.memberProjects ?? [
      project,
    ];
  const items = buildProjectActionItems({
    projects: input.projects,
    valuePrefix: "project",
    searchTerms: (project) =>
      buildCommandPaletteProjectMetadata({
        projects: membersOf(project),
        locationByEnvironmentId: input.locationByEnvironmentId,
      }).searchTerms,
    renderDescription: (project) => {
      const members = membersOf(project);
      const metadata = buildCommandPaletteProjectMetadata({
        projects: members,
        locationByEnvironmentId: input.locationByEnvironmentId,
      });
      return members.length > 1 ? (
        <span className="truncate">{metadata.environmentLabels.join(" · ")}</span>
      ) : (
        <ProjectLocationDescription
          location={input.locationByEnvironmentId.get(project.environmentId)}
          workspaceRoot={project.workspaceRoot}
        />
      );
    },
    icon: projectFaviconIcon,
    runProject: input.runProject,
    ...(input.pin ? { pin: input.pin } : {}),
  });
  return items.flatMap((item, index): CommandPaletteActionItem[] => {
    const target = input.projects[index]!;
    const group = input.projectGroupByTargetKey.get(`${target.environmentId}:${target.id}`);
    const umbrellas = group?.memberProjects.filter(isUmbrellaProject) ?? [];
    const umbrella =
      umbrellas.find((project) => project.environmentId === target.environmentId) ?? umbrellas[0];
    if (group === undefined || umbrella === undefined) return [item];
    const projectByMemberPath = new Map(
      group.memberProjects.flatMap((project) => {
        const member = group.foldedUmbrellaMembers.get(`${project.environmentId}:${project.id}`);
        return member ? [[member.path, project] as const] : [];
      }),
    );
    const { description: _description, ...umbrellaRow } = item;
    return [
      {
        ...umbrellaRow,
        searchTerms: [group.displayName, umbrella.title],
        icon: projectFaviconIcon(umbrella),
      },
      ...(umbrella.umbrellaMembers ?? []).map((member) => {
        const label = umbrellaMemberLabel(member);
        const project = projectByMemberPath.get(member.path);
        return {
          kind: "action" as const,
          value: `project-member:${umbrella.environmentId}:${umbrella.id}:${member.path}`,
          parentValue: item.value,
          searchTerms: project ? [label, project.title] : [label],
          title: label,
          icon: (
            <ProjectFavicon
              project={
                project ?? {
                  environmentId: umbrella.environmentId,
                  workspaceRoot: member.path,
                  title: label,
                }
              }
              className={ITEM_ICON_CLASS}
            />
          ),
          // A checkout with no project of its own opens in the umbrella.
          run: project
            ? () => input.openMemberProject({ ...project, displayName: project.title })
            : item.run,
        };
      }),
    ];
  });
}

/** Projects as targets of the "New thread in..." submenu. */
export function buildNewThreadInProjectItems(
  input: ProjectItemsInput & { readonly currentProjectKey: string | null },
) {
  return buildProjectActionItems({
    projects: input.projects,
    valuePrefix: "new-thread-in",
    searchTerms: (project) => {
      const group = input.projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
      const location = input.locationByEnvironmentId.get(project.environmentId);
      return [
        ...(group?.memberProjects.flatMap((member) => [member.title, member.workspaceRoot]) ?? []),
        ...(location ? [location.label] : []),
      ];
    },
    renderDescription: (project) => (
      <ProjectLocationDescription
        location={input.locationByEnvironmentId.get(project.environmentId)}
        workspaceRoot={project.workspaceRoot}
        current={input.currentProjectKey === `${project.environmentId}:${project.id}`}
      />
    ),
    icon: projectFaviconIcon,
    runProject: input.runProject,
    ...(input.pin ? { pin: input.pin } : {}),
  });
}

function ProjectLocationDescription(props: {
  readonly location: CommandPaletteProjectLocation | undefined;
  readonly workspaceRoot: string;
  readonly current?: boolean;
}) {
  const location = props.location ?? UNKNOWN_PROJECT_LOCATION;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {props.current ? (
        <>
          <span className="shrink-0">Current</span>
          <CommandPaletteMetaDot />
        </>
      ) : null}
      <span className="inline-flex min-w-0 items-center gap-1">
        {location.kind === "remote" ? (
          <EnvironmentMachineIcon
            aria-hidden
            kind={location.machine}
            className={COMMAND_PALETTE_META_ICON_CLASS}
          />
        ) : null}
        <span className="truncate">{location.label}</span>
      </span>
      <CommandPaletteMetaDot />
      <span className="min-w-0 flex-1 truncate">{props.workspaceRoot}</span>
    </span>
  );
}
