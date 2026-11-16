import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  adoptUmbrellaMember,
  removeUmbrellaMember,
  restoreUmbrellaMember,
} from "@t3tools/client-runtime/state/umbrella";
import type { ProjectSettingsOverrides, UmbrellaMember } from "@t3tools/contracts";

import { useEditProjectOverrides } from "../components/settings/useScopedSettings";

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
  return {
    adopt: (umbrella: Umbrella, path: string) =>
      edit(umbrella, (current) => adoptUmbrellaMember(umbrella, current, path)),
    remove: (umbrella: Umbrella, member: Pick<UmbrellaMember, "path" | "source">) =>
      edit(umbrella, (current) => removeUmbrellaMember(umbrella, current, member)),
    restore: (umbrella: Umbrella, path: string) =>
      edit(umbrella, (current) => restoreUmbrellaMember(umbrella, current, path)),
  };
}
