import { useAtomValue } from "@effect/atom-react";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import type { DesktopOpenWindow, DesktopWindowsBridge } from "@t3tools/contracts";
import { AppWindowIcon, Maximize2Icon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Skeleton } from "../../components/ui/skeleton";
import { readUsagePagePreferences } from "../../components/usage/usagePagePreferences";
import { PROVIDER_PRESENTATION } from "../../components/usage/usageProviders";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { ensureLocalApi } from "../../localApi";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { desktopWindowsBridge } from "../windowContext";
import { useDesktopWindowsState } from "../windowsState";
import { MiniUsageSection } from "./MiniUsage";
import { deriveMiniUsage, type MiniUsage, withoutHiddenProviders } from "./miniUsage.logic";
import { notifyWindowActionFailure, openNewDesktopWindow } from "./windowActions";

const CLOCK_TICK_MS = 60_000;

/** The main window's compact stand-in for the app shell while Mini Mode is on. */
export function MiniMainWindow() {
  const [bridge] = useState(desktopWindowsBridge);
  return bridge === null ? null : <MiniMainWindowContent bridge={bridge} />;
}

function MiniMainWindowContent({ bridge }: { readonly bridge: DesktopWindowsBridge }) {
  const windowsState = useDesktopWindowsState();
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [hiddenDrivers] = useState(
    () =>
      new Set(
        (readUsagePagePreferences().hiddenProviders ?? []).map(
          (provider) => PROVIDER_PRESENTATION[provider].driverKind,
        ),
      ),
  );

  const refreshLimits = (automatic: boolean) =>
    Promise.allSettled(
      Array.from(presentations, ([environmentId, presentation]) =>
        presentation.connection.phase === "connected" && presentation.serverConfig !== null
          ? refreshUsageLimits(
              environmentId,
              () => refreshProviders({ environmentId, input: {} }),
              automatic,
            )
          : undefined,
      ),
    ).then(() => setNow(Date.now()));
  const autoRefresh = useEffectEvent(() => {
    void refreshLimits(true);
  });
  const wake = useEffectEvent(() => {
    setNow(Date.now());
    autoRefresh();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the wall clock once a minute while visible, and when the window regains focus
  useEffect(() => {
    const tick = setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, CLOCK_TICK_MS);
    globalThis.window.addEventListener("focus", wake);
    return () => {
      clearInterval(tick);
      globalThis.window.removeEventListener("focus", wake);
    };
  }, []);
  const connectedEnvironments = [...presentations]
    .filter(
      ([, presentation]) =>
        presentation.connection.phase === "connected" && presentation.serverConfig !== null,
    )
    .map(([environmentId]) => environmentId)
    .sort()
    .join(",");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- rereads provider limits from the server when the panel opens or the connected environment set changes
  useEffect(() => {
    if (connectedEnvironments) autoRefresh();
  }, [connectedEnvironments]);

  return (
    <MiniPanel
      usage={deriveMiniUsage(withoutHiddenProviders(presentations, hiddenDrivers), now)}
      now={now}
      refreshing={refreshing}
      windows={windowsState?.windows.filter((window) => !window.isMain) ?? null}
      onRefresh={() => {
        setRefreshing(true);
        void refreshLimits(false).then(() => setRefreshing(false));
      }}
      onOpenExternal={(url) => void ensureLocalApi().shell.openExternal(url)}
      onExpand={() => {
        bridge.setMiniMode(false).catch((cause: unknown) => {
          notifyWindowActionFailure("Couldn't leave Mini Mode", cause);
        });
      }}
      onNewWindow={() => openNewDesktopWindow(bridge)}
      onFocusWindow={(windowId) => {
        bridge.focus(windowId).catch((cause: unknown) => {
          notifyWindowActionFailure("Couldn't focus the window", cause);
        });
      }}
    />
  );
}

/** Usage keeps its natural height and comes first; the window list takes what is left and scrolls. */
export function MiniPanel({
  usage,
  now,
  refreshing,
  windows,
  onRefresh,
  onOpenExternal,
  onExpand,
  onNewWindow,
  onFocusWindow,
}: {
  readonly usage: MiniUsage;
  readonly now: number;
  readonly refreshing: boolean;
  /** Null until the desktop shell reports its windows. */
  readonly windows: readonly DesktopOpenWindow[] | null;
  readonly onRefresh: () => void;
  readonly onOpenExternal: (url: string) => void;
  readonly onExpand: () => void;
  readonly onNewWindow: () => void;
  readonly onFocusWindow: (windowId: number) => void;
}) {
  return (
    <div className="flex h-dvh min-h-0 w-full flex-col bg-background text-foreground">
      <WorkspacePageHeader electron className="pl-(--workspace-controls-left)">
        <h1 className="min-w-0 flex-1 truncate font-medium text-sm">Mini Mode</h1>
        <Button size="compact" variant="outline" onClick={onExpand}>
          <Maximize2Icon />
          Expand
        </Button>
      </WorkspacePageHeader>
      <div className="flex min-h-0 shrink flex-col">
        <ScrollArea scrollFade>
          <MiniUsageSection
            usage={usage}
            now={now}
            refreshing={refreshing}
            onRefresh={onRefresh}
            onOpenExternal={onOpenExternal}
          />
        </ScrollArea>
      </div>
      <section
        aria-labelledby="mini-mode-windows"
        className="flex min-h-36 flex-1 basis-0 flex-col border-border/60 border-t pt-1.5"
      >
        <div className="flex h-6 shrink-0 items-center gap-1.5 px-3">
          <h2 id="mini-mode-windows" className="font-medium text-muted-foreground text-xs">
            Windows
          </h2>
          {windows !== null && windows.length > 0 ? (
            <span className="text-2xs text-muted-foreground tabular-nums">{windows.length}</span>
          ) : null}
          <span className="ms-auto">
            <Button size="compact" variant="ghost" onClick={onNewWindow}>
              <AppWindowIcon />
              New Window
            </Button>
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <ScrollArea scrollFade>
            {windows === null ? (
              <div className="px-3 py-1.5">
                <Skeleton className="h-3 w-32" />
              </div>
            ) : windows.length === 0 ? (
              <p className="px-3 py-1 text-muted-foreground text-xs">No other windows are open.</p>
            ) : (
              <ul className="flex flex-col px-1.5 pb-1.5">
                {windows.map((window) => (
                  <MiniModeWindowRow
                    key={window.windowId}
                    window={window}
                    onFocus={() => onFocusWindow(window.windowId)}
                  />
                ))}
              </ul>
            )}
          </ScrollArea>
        </div>
      </section>
    </div>
  );
}

function MiniModeWindowRow({
  window,
  onFocus,
}: {
  readonly window: DesktopOpenWindow;
  readonly onFocus: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={window.focused ? "true" : undefined}
        className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-xs outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-[current]:bg-accent/60"
        onClick={onFocus}
      >
        <span className="max-w-3/5 shrink-0 truncate font-medium text-foreground">
          {window.name}
        </span>
        {window.profileId === null ? (
          <span className="shrink-0 text-2xs text-muted-foreground">Unsaved</span>
        ) : null}
        {window.title ? (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{window.title}</span>
        ) : null}
      </button>
    </li>
  );
}
