import { useGT } from "gt-react";
import { AppWindowIcon, BotIcon } from "lucide-react";
import { useState } from "react";

import { desktopWindowsBridge } from "../multiWindow/windowContext";
import { openDesktopBotWindow, openNewDesktopWindow } from "../multiWindow/ui/windowActions";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "./CommandPalette.logic";

/** Desktop window actions; empty on the web and in shells without multi-window support. */
export function useCommandPaletteWindowItems(): ReadonlyArray<CommandPaletteActionItem> {
  const [bridge] = useState(desktopWindowsBridge);
  const gt = useGT();
  if (bridge === null) return [];
  const items: CommandPaletteActionItem[] = [
    {
      kind: "action",
      value: "action:window-new",
      title: gt("New Window"),
      searchTerms: ["new window", "window", "open window", "multiple windows"],
      icon: <AppWindowIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "window.new",
      run: async () => openNewDesktopWindow(bridge),
    },
  ];
  const bot = bridge.bot;
  if (bot !== undefined) {
    items.push({
      kind: "action",
      value: "action:bot-open",
      title: gt("Open T3_BOT"),
      searchTerms: ["bot", "t3_bot", "assistant", "open bot"],
      icon: <BotIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "bot.open",
      run: async () => openDesktopBotWindow(bot),
    });
  }
  return items;
}
