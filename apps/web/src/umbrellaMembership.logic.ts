import {
  findUmbrellaMembership,
  type ProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  umbrellaAdoptionTargets,
  umbrellaMemberLabel,
} from "@t3tools/client-runtime/state/umbrella";
import type { ContextMenuItem, UmbrellaMember } from "@t3tools/contracts";

interface UmbrellaAdoption<TProject> {
  readonly umbrella: TProject;
  readonly path: string;
}

export interface UmbrellaRemoval<TProject> {
  readonly umbrella: TProject;
  readonly member: UmbrellaMember;
  readonly project: EnvironmentProject;
  /** A repository match is another clone grouped under the umbrella; leaving only ungroups it. */
  readonly match: "folder" | "repository";
}

/**
 * What the given projects can do with umbrellas: join one on their environment, or leave the
 * one they belong to. A project already in an umbrella only offers to leave it.
 */
export function umbrellaMembershipActions<TProject extends EnvironmentProject>(
  subjects: ReadonlyArray<EnvironmentProject>,
  projects: ReadonlyArray<TProject>,
  settings: ProjectGroupingSettings,
): {
  readonly adoptions: ReadonlyArray<UmbrellaAdoption<TProject>>;
  readonly removals: ReadonlyArray<UmbrellaRemoval<TProject>>;
} {
  const adoptions = new Map<string, UmbrellaAdoption<TProject>>();
  const removals = new Map<string, UmbrellaRemoval<TProject>>();
  for (const project of subjects) {
    if (project.isScratch) continue;
    const membership = findUmbrellaMembership(project, projects, settings);
    if (membership !== null) {
      const { umbrella, member } = membership;
      removals.set(
        `${umbrella.environmentId}:${umbrella.id}\0${member.path}\0${project.environmentId}:${project.id}`,
        { ...membership, project },
      );
      continue;
    }
    for (const umbrella of umbrellaAdoptionTargets(project, projects)) {
      const key = `${umbrella.environmentId}:${umbrella.id}`;
      if (!adoptions.has(key)) adoptions.set(key, { umbrella, path: project.workspaceRoot });
    }
  }
  return { adoptions: [...adoptions.values()], removals: [...removals.values()] };
}

const ADOPT_PREFIX = "umbrella-adopt:";
const REMOVE_PREFIX = "umbrella-remove:";

export function umbrellaMenuItems(
  actions: ReturnType<typeof umbrellaMembershipActions>,
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (actions.adoptions.length > 0) {
    items.push({
      id: "umbrella-adopt",
      label: "Add to umbrella",
      children: actions.adoptions.map((adoption, index) => ({
        id: `${ADOPT_PREFIX}${index}`,
        label: adoption.umbrella.title,
      })),
    });
  }
  const [onlyRemoval] = actions.removals;
  if (actions.removals.length === 1 && onlyRemoval) {
    items.push({
      id: `${REMOVE_PREFIX}0`,
      // Named, since the folder clicked can be the umbrella itself holding a folded member.
      label: `Remove ${umbrellaMemberLabel(onlyRemoval.member)} from umbrella`,
      detail: onlyRemoval.umbrella.title,
    });
  } else if (actions.removals.length > 1) {
    items.push({
      id: "umbrella-remove",
      label: "Remove from umbrella",
      children: actions.removals.map((removal, index) => ({
        id: `${REMOVE_PREFIX}${index}`,
        label: `${umbrellaMemberLabel(removal.member)} (${removal.umbrella.title})`,
      })),
    });
  }
  return items;
}

/** The action a clicked `umbrellaMenuItems` id stands for, or null for any other id. */
export function resolveUmbrellaMenuAction<TProject>(
  actions: {
    readonly adoptions: ReadonlyArray<UmbrellaAdoption<TProject>>;
    readonly removals: ReadonlyArray<UmbrellaRemoval<TProject>>;
  },
  id: string | null,
):
  | ({ readonly kind: "adopt" } & UmbrellaAdoption<TProject>)
  | ({ readonly kind: "remove" } & UmbrellaRemoval<TProject>)
  | null {
  if (id === null) return null;
  if (id.startsWith(ADOPT_PREFIX)) {
    const adoption = actions.adoptions[Number(id.slice(ADOPT_PREFIX.length))];
    return adoption ? { kind: "adopt", ...adoption } : null;
  }
  if (id.startsWith(REMOVE_PREFIX)) {
    const removal = actions.removals[Number(id.slice(REMOVE_PREFIX.length))];
    return removal ? { kind: "remove", ...removal } : null;
  }
  return null;
}

/** The confirmation that lists every checkout an umbrella will take in, and what changes, before it is turned on. */
export function umbrellaConfirmationMessage(
  title: string,
  checkouts: ReadonlyArray<Pick<UmbrellaMember, "relativePath">>,
): string {
  return [
    `Use ${title} as an umbrella?`,
    `${title} will span these checkouts:`,
    ...checkouts.map((checkout) => `• ${umbrellaMemberLabel(checkout)}`),
    `The diff panel shows each one's changes, turns checkpoint them so reverting a turn restores them, and their projects' threads group under ${title}. You can turn this off in project settings.`,
  ].join("\n");
}
