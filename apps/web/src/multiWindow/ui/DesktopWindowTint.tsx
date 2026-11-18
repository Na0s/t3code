import type { DesktopWindowContext } from "@t3tools/contracts";
import { useEffect } from "react";

import { setWindowThemeTint, useRenderedAppearance } from "../../hooks/useTheme";
import { useUiStateStore } from "../../uiStateStore";
import { readDesktopWindowContext } from "../windowContext";
import { resolveWindowThemeOverride, useDesktopWindowsState } from "../windowsState";
import { useProjectScopeGroups } from "./useProjectScopeGroups";
import { resolveWindowTint, windowTintGradient } from "./windowTint.logic";

/** A secondary window's project colour; renders nothing in the main window. */
export function DesktopWindowTint() {
  const context = readDesktopWindowContext();
  return context === null || context.isMain ? null : <SecondaryWindowTint context={context} />;
}

function SecondaryWindowTint({ context }: { readonly context: DesktopWindowContext }) {
  const windowsState = useDesktopWindowsState();
  const scopeKeys = useUiStateStore((store) => store.sidebarProjectScopeKeys);
  const { groupsForKeys } = useProjectScopeGroups();
  const appearance = useRenderedAppearance();
  const tint = resolveWindowTint({
    isSecondaryWindow: true,
    explicitTheme: resolveWindowThemeOverride(windowsState, context),
    projects: groupsForKeys(scopeKeys),
  });
  const solidTint = tint.kind === "solid" ? tint.color : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the tint into the theme module, which paints the document root's variables
  useEffect(() => {
    setWindowThemeTint(solidTint);
    return () => setWindowThemeTint(null);
  }, [solidTint]);

  if (tint.kind !== "gradient") return null;
  return (
    <div
      aria-hidden
      data-window-tint
      className="pointer-events-none fixed inset-0 z-[200]"
      style={{ backgroundImage: windowTintGradient(tint.colors, appearance) }}
    />
  );
}
