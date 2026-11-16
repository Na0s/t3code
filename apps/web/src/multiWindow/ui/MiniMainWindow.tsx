import type { DesktopOpenWindow, DesktopWindowsBridge } from "@t3tools/contracts";
import { AppWindowIcon, Maximize2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";
import { UsageLimitsSection } from "../../components/usage/UsageLimits";
import { readUsagePagePreferences } from "../../components/usage/usagePagePreferences";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { desktopWindowsBridge } from "../windowContext";
import { useDesktopWindowsState } from "../windowsState";
import { notifyWindowActionFailure, openNewDesktopWindow } from "./windowActions";

/** The main window's compact stand-in for the app shell while Mini Mode is on. */
export function MiniMainWindow() {
  const [bridge] = useState(desktopWindowsBridge);
  const windowsState = useDesktopWindowsState();
  // Limits advance on the Usage page's refresh, so a fixed reference time keeps this panel still.
  const [now] = useState(() => Date.now());
  const [hiddenProviders] = useState(() => new Set(readUsagePagePreferences().hiddenProviders));
  if (bridge === null) return null;
  const otherWindows = (windowsState?.windows ?? []).filter((window) => !window.isMain);

  return (
    <div className="flex h-dvh min-h-0 w-full flex-col bg-background text-foreground">
      <WorkspacePageHeader electron className="pl-(--workspace-controls-left)">
        <h1 className="min-w-0 flex-1 truncate font-medium text-sm">Mini Mode</h1>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            bridge.setMiniMode(false).catch((cause: unknown) => {
              notifyWindowActionFailure("Couldn't leave Mini Mode", cause);
            });
          }}
        >
          <Maximize2Icon />
          Expand
        </Button>
      </WorkspacePageHeader>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 px-3 pb-4">
          <section aria-labelledby="mini-mode-windows" className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2 px-1">
              <h2 id="mini-mode-windows" className="font-medium text-muted-foreground text-xs">
                Windows
              </h2>
              <Button size="xs" variant="ghost" onClick={() => openNewDesktopWindow(bridge)}>
                <AppWindowIcon />
                New Window
              </Button>
            </div>
            {otherWindows.length === 0 ? (
              <p className="px-1 text-muted-foreground text-sm">No other windows are open.</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {otherWindows.map((window) => (
                  <MiniModeWindowRow key={window.windowId} window={window} bridge={bridge} />
                ))}
              </ul>
            )}
          </section>
          <section aria-label="Usage limits">
            <UsageLimitsSection
              selectedEnvironmentIds={null}
              hiddenProviders={hiddenProviders}
              now={now}
            />
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}

function MiniModeWindowRow({
  window,
  bridge,
}: {
  readonly window: DesktopOpenWindow;
  readonly bridge: DesktopWindowsBridge;
}) {
  return (
    <li>
      <button
        type="button"
        className="flex w-full min-w-0 flex-col items-start rounded-md px-2 py-1.5 text-left outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={() => {
          bridge.focus(window.windowId).catch((cause: unknown) => {
            notifyWindowActionFailure("Couldn't focus the window", cause);
          });
        }}
      >
        <span className="w-full truncate text-sm">
          {window.name}
          {window.profileId === null ? (
            <span className="text-muted-foreground"> · Unsaved</span>
          ) : null}
        </span>
        {window.title ? (
          <span className="w-full truncate text-muted-foreground text-xs">{window.title}</span>
        ) : null}
      </button>
    </li>
  );
}
