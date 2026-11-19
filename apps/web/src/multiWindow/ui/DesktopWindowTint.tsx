import type { DesktopWindowContext } from "@t3tools/contracts";

import { useUiStateStore } from "../../uiStateStore";
import { readDesktopWindowContext } from "../windowContext";
import { resolveWindowThemeOverride, useDesktopWindowsState } from "../windowsState";
import { useProjectScopeGroups } from "./useProjectScopeGroups";
import { useProjectTintColors } from "./useProjectTintColors";
import { tintBackground } from "./windowTint.logic";

/**
 * A secondary window's project colours across the sidebar's top banner. The main window, an
 * unfiltered window and a window with its own theme show none.
 */
export function DesktopWindowTint() {
  const context = readDesktopWindowContext();
  return context === null || context.isMain ? null : <SecondaryWindowTint context={context} />;
}

function SecondaryWindowTint({ context }: { readonly context: DesktopWindowContext }) {
  const windowsState = useDesktopWindowsState();
  const scopeKeys = useUiStateStore((store) => store.sidebarProjectScopeKeys);
  const { groupsForKeys } = useProjectScopeGroups();
  const colors = useProjectTintColors(groupsForKeys(scopeKeys));
  if (colors.length === 0 || resolveWindowThemeOverride(windowsState, context) !== null) {
    return null;
  }
  return (
    <div
      aria-hidden
      data-window-tint
      // As tall as the stage artwork: under the title bar and the Search row, fading out below.
      className="pointer-events-none absolute inset-x-0 top-0 z-0 h-20 opacity-30 mask-b-from-40% dark:opacity-40"
      style={{ background: tintBackground(colors) }}
    />
  );
}
