import type { DesktopWindowsBridge } from "@t3tools/contracts";
import { msg } from "gt-react";

import { toastManager } from "../../components/ui/toast";
import { m } from "../../i18n/messages";
import { registerCommands, registerMenuAction } from "../../shortcuts/dispatcher";
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

/** The New Window shortcut and menu item; a no-op outside a multi-window desktop shell. */
export function registerDesktopWindowCommands(): () => void {
  const bridge = desktopWindowsBridge();
  if (bridge === null) return () => {};
  const disposers = [
    registerCommands({
      "window.new": (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) openNewDesktopWindow(bridge);
      },
    }),
    registerMenuAction("new-window", () => openNewDesktopWindow(bridge)),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
