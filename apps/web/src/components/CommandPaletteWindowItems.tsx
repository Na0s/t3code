import { AppWindowIcon } from "lucide-react";
import { useState } from "react";

import { desktopWindowsBridge } from "../multiWindow/windowContext";
import { openNewDesktopWindow } from "../multiWindow/ui/windowActions";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "./CommandPalette.logic";

/** Desktop multi-window actions; empty on the web and in shells without multi-window support. */
export function useCommandPaletteWindowItems(): ReadonlyArray<CommandPaletteActionItem> {
  const [bridge] = useState(desktopWindowsBridge);
  if (bridge === null) return [];
  return [
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
}
