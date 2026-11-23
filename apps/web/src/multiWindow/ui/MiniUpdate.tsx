import { managedUpdatesDenial } from "@t3tools/client-runtime/contract-labels";
import { useGT, useMessages } from "gt-react";

import { APP_DISPLAY_NAME } from "../../branding";
import {
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateDisabledReason,
} from "../../components/desktopUpdate.logic";
import { SidebarProviderUpdatePill } from "../../components/sidebar/SidebarProviderUpdatePill";
import {
  SidebarUpdateArchitectureWarning,
  SidebarUpdatePill,
} from "../../components/sidebar/SidebarUpdatePill";
import { SidebarMenu } from "../../components/ui/sidebar";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { usePrimaryManagedPolicy } from "../../state/managedPolicy";

/** The Update tab: the running version, where its update stands, and the sidebar's own update controls. */
export function MiniUpdate() {
  const gt = useGT();
  const messages = useMessages();
  const state = useDesktopUpdateState();
  const disabledReason = getDesktopUpdateDisabledReason(
    state,
    managedUpdatesDenial(usePrimaryManagedPolicy(), messages),
    messages,
  );
  return (
    <section
      aria-label={gt("Update", { $context: "Mini Mode tab about app updates" })}
      className="flex flex-col gap-2 p-(--sidebar-content-inset)"
    >
      <div className="flex items-center gap-2 ps-(--sidebar-row-content-inset)">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-sm">
            {APP_DISPLAY_NAME} {state?.currentVersion}
          </p>
          <p role="status" className="text-secondary-label text-xs">
            {disabledReason ??
              (state === null ? null : getDesktopUpdateButtonTooltip(state, messages))}
          </p>
        </div>
        <SidebarMenu className="w-auto shrink-0 flex-row">
          <SidebarUpdatePill />
        </SidebarMenu>
      </div>
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
    </section>
  );
}
