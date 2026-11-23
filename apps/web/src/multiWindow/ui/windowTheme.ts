import { setWindowThemeOverride } from "../../hooks/useTheme";
import { desktopWindowsBridge, readDesktopWindowContext } from "../windowContext";
import {
  readDesktopWindowsState,
  resolveWindowThemeOverride,
  selectCurrentWindowProfile,
  subscribeDesktopWindowsState,
} from "../windowsState";

let installed = false;

/** Applies a secondary window's profile theme in place of the shared one, live. */
export function installDesktopWindowTheme(): void {
  const bridge = desktopWindowsBridge();
  const context = readDesktopWindowContext();
  if (installed || bridge === null || context === null || context.isMain) return;
  installed = true;
  const sync = () => {
    const windowsState = readDesktopWindowsState();
    const theme = resolveWindowThemeOverride(windowsState, context);
    const profileId =
      windowsState === null
        ? context.profileId
        : (selectCurrentWindowProfile(windowsState, context)?.id ?? null);
    if (theme === null || profileId === null) {
      setWindowThemeOverride(null);
      return;
    }
    setWindowThemeOverride({
      theme,
      save: (next) => {
        bridge.updateProfile({ profileId, theme: next }).catch((cause: unknown) => {
          console.error("Failed to save the window theme.", cause);
          sync();
        });
      },
    });
  };
  sync();
  subscribeDesktopWindowsState(sync);
}
