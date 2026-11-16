import { AppWindowIcon, Maximize2Icon, PictureInPicture2Icon } from "lucide-react";
import { useState } from "react";

import { desktopWindowsBridge, readDesktopWindowContext } from "../multiWindow/windowContext";
import { selectCurrentWindowProfile, useDesktopWindowsState } from "../multiWindow/windowsState";
import { notifyWindowActionFailure, openNewDesktopWindow } from "../multiWindow/ui/windowActions";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "./CommandPalette.logic";

/** Desktop multi-window actions; empty on the web and in shells without multi-window support. */
export function useCommandPaletteWindowItems(): ReadonlyArray<CommandPaletteActionItem> {
  const [bridge] = useState(desktopWindowsBridge);
  const windowsState = useDesktopWindowsState();
  if (bridge === null) return [];
  const context = readDesktopWindowContext();
  const currentProfileId = selectCurrentWindowProfile(windowsState, context)?.id ?? null;

  const items: CommandPaletteActionItem[] = [
    {
      kind: "action",
      value: "action:window-new",
      title: "New Window",
      searchTerms: ["new window", "window", "open window", "multiple windows"],
      icon: <AppWindowIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "window.new",
      run: async () => openNewDesktopWindow(bridge),
    },
  ];
  for (const profile of windowsState?.profiles ?? []) {
    if (profile.isDefault || profile.id === currentProfileId) continue;
    items.push({
      kind: "action",
      value: `action:window-open:${profile.id}`,
      title: `Open window: ${profile.name}`,
      searchTerms: ["window", "open window", "saved window", profile.name],
      icon: <AppWindowIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await bridge.openProfile(profile.id).catch((cause: unknown) => {
          notifyWindowActionFailure("Couldn't open the window", cause);
        });
      },
    });
  }
  if (context?.isMain === true) {
    const miniMode = windowsState?.miniMode === true;
    items.push({
      kind: "action",
      value: "action:window-mini-mode",
      title: miniMode ? "Exit Mini Mode" : "Enter Mini Mode",
      searchTerms: ["mini mode", "compact", "windows", "usage limits", "collapse", "expand"],
      icon: miniMode ? (
        <Maximize2Icon className={ITEM_ICON_CLASS} />
      ) : (
        <PictureInPicture2Icon className={ITEM_ICON_CLASS} />
      ),
      run: async () => {
        await bridge.setMiniMode(!miniMode).catch((cause: unknown) => {
          notifyWindowActionFailure("Couldn't change Mini Mode", cause);
        });
      },
    });
  }
  return items;
}
