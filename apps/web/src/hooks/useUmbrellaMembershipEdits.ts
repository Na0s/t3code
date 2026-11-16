import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import {
  adoptUmbrellaMember,
  removeUmbrellaMember,
  restoreUmbrellaMember,
  setUmbrellaEnabled,
} from "@t3tools/client-runtime/state/umbrella";
import type { ProjectSettingsOverrides, UmbrellaMember } from "@t3tools/contracts";

import { useEditProjectOverrides } from "../components/settings/useScopedSettings";
import { toastManager } from "../components/ui/toast";
import { withProjectGroupingOverride } from "../sidebarProjectGrouping";
import { requestConfirmDialog } from "../confirmDialog";
import { umbrellaConfirmationMessage, type UmbrellaRemoval } from "../umbrellaMembership.logic";
import { persistClientSettingsUpdate } from "./useSettings";

type Umbrella = Pick<EnvironmentProject, "environmentId" | "id" | "workspaceRoot">;

/** Adopt, remove, and restore umbrella members through the umbrella's own project overrides. */
export function useUmbrellaMembershipEdits() {
  const editOverrides = useEditProjectOverrides();
  const edit = (
    umbrella: Umbrella,
    change: (current: ProjectSettingsOverrides | undefined) => Partial<ProjectSettingsOverrides>,
  ) =>
    editOverrides({ environmentId: umbrella.environmentId, projectId: umbrella.id }, (current) => ({
      ...current,
      ...change(current),
    }));
  const remove = (umbrella: Umbrella, member: Pick<UmbrellaMember, "path" | "source">) =>
    edit(umbrella, (current) => removeUmbrellaMember(umbrella, current, member));
  return {
    setEnabled: (umbrella: Umbrella, enabled: boolean) =>
      edit(umbrella, (current) => setUmbrellaEnabled(current, enabled)),
    /** Lists the checkouts that will join, then turns the umbrella on once the user confirms. */
    confirmEnable: async (
      umbrella: Umbrella & Pick<EnvironmentProject, "title" | "umbrellaSuggestions">,
    ) => {
      const confirmed = await requestConfirmDialog(
        umbrellaConfirmationMessage(umbrella.title, umbrella.umbrellaSuggestions ?? []),
        { initialFocus: "confirm" },
      );
      if (confirmed === true) edit(umbrella, (current) => setUmbrellaEnabled(current, true));
    },
    adopt: (umbrella: Umbrella, path: string) =>
      edit(umbrella, (current) => adoptUmbrellaMember(umbrella, current, path)),
    remove,
    restore: (umbrella: Umbrella, path: string) =>
      edit(umbrella, (current) => restoreUmbrellaMember(umbrella, current, path)),
    /** The umbrella's own checkout leaves it; another clone only stops grouping under it. */
    leave: (removal: UmbrellaRemoval<Umbrella>) => {
      if (removal.match === "folder") return remove(removal.umbrella, removal.member);
      const overrideKey = derivePhysicalProjectKey(removal.project);
      void persistClientSettingsUpdate((current) => ({
        ...current,
        sidebarProjectGroupingOverrides: withProjectGroupingOverride(
          current.sidebarProjectGroupingOverrides,
          overrideKey,
          "separate",
        ),
      })).catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not ungroup the project",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      });
    },
  };
}
