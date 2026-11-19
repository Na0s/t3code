import { ChevronRightIcon } from "lucide-react";

import { SidebarMenuButton } from "../../components/ui/sidebar";
import { Switch } from "../../components/ui/switch";

/** The one setting that changes what the panel offers, and the way to the rest. */
export function MiniSettings({
  multiWindowEnabled,
  onMultiWindowEnabledChange,
  onOpenSettings,
}: {
  readonly multiWindowEnabled: boolean;
  readonly onMultiWindowEnabledChange: (enabled: boolean) => void;
  readonly onOpenSettings: () => void;
}) {
  return (
    <section aria-label="Settings" className="flex flex-col gap-1 p-(--sidebar-content-inset)">
      <div className="flex min-h-8 items-center gap-3 px-(--sidebar-row-content-inset) py-1.5">
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-sm">Multiple windows</span>
          <span className="block text-secondary-label text-xs">
            Turning this off keeps open windows open.
          </span>
        </span>
        <Switch
          aria-label="Multiple windows"
          checked={multiWindowEnabled}
          onCheckedChange={onMultiWindowEnabledChange}
        />
      </div>
      <SidebarMenuButton onClick={onOpenSettings}>
        <span className="flex-1">All settings</span>
        <ChevronRightIcon />
      </SidebarMenuButton>
    </section>
  );
}
