import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";

import { useClientSettings } from "../../hooks/useSettings";
import {
  buildSidebarProjectSnapshots,
  resolveSidebarProjectScopeKeys,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";

/** The project groups a window's project filter picks from, keyed as the sidebar keys them. */
export function useProjectScopeGroups() {
  const projects = useProjects();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const groups = buildSidebarProjectSnapshots({
    projects,
    groupScratchProjects: true,
    settings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: () => null,
  }).filter((group) => !group.archived);
  const groupsForKeys = (keys: readonly string[]): SidebarProjectSnapshot[] =>
    resolveSidebarProjectScopeKeys({ groups, keys, settings }).flatMap(
      (key) => groups.find((group) => group.projectKey === key) ?? [],
    );
  return { groups, groupsForKeys };
}
