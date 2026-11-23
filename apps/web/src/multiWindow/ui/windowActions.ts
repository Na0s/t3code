import type { DesktopBotWindowBridge, DesktopWindowsBridge } from "@t3tools/contracts";
import { msg } from "gt-react";

import { toastManager } from "../../components/ui/toast";
import { m } from "../../i18n/messages";
import {
  type CommandHandlers,
  registerCommands,
  registerMenuAction,
} from "../../shortcuts/dispatcher";
import { desktopWindowsBridge } from "../windowContext";

function notifyWindowActionFailure(title: string, cause: unknown): void {
  console.error(title, cause);
  toastManager.add({
    type: "error",
    title,
    description: cause instanceof Error ? cause.message : undefined,
  });
}

export function openNewDesktopWindow(bridge: DesktopWindowsBridge): void {
  bridge.openNew().catch((cause: unknown) => {
    notifyWindowActionFailure(m(msg("Couldn't open a new window")), cause);
  });
}

export function openDesktopBotWindow(bot: DesktopBotWindowBridge): void {
  bot.open().catch((cause: unknown) => {
    notifyWindowActionFailure(m(msg("Couldn't open T3_BOT")), cause);
  });
}

/** The New Window and Open T3_BOT shortcuts and menu items; no-ops outside a desktop shell that has them. */
export function registerDesktopWindowCommands(): () => void {
  const bridge = desktopWindowsBridge();
  if (bridge === null) return () => {};
  const commands: CommandHandlers = {
    "window.new": (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) openNewDesktopWindow(bridge);
    },
  };
  const bot = bridge.bot;
  if (bot !== undefined) {
    commands["bot.open"] = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) openDesktopBotWindow(bot);
    };
  }
  const disposers = [
    registerCommands(commands),
    registerMenuAction("new-window", () => openNewDesktopWindow(bridge)),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
