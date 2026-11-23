import { useRouter } from "@tanstack/react-router";
import type { DesktopWindowsBridge } from "@t3tools/contracts";
import { useGT } from "gt-react";
import {
  AppWindowIcon,
  ChartNoAxesColumnIcon,
  CircleArrowUpIcon,
  LayersIcon,
  Maximize2Icon,
  SearchIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { CommandPalette } from "../../components/CommandPalette";
import { resolveDesktopUpdateButtonAction } from "../../components/desktopUpdate.logic";
import { PullRequestGlyph } from "../../components/pullRequest/pullRequestIcons";
import { SidebarHeaderIconButton } from "../../components/sidebar/SidebarThreadHeader";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SidebarProvider } from "../../components/ui/sidebar";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { usePullRequestsSupported } from "../../state/environments";
import { desktopWindowsBridge } from "../windowContext";
import { useDesktopWindowsState } from "../windowsState";
import { MiniPullRequests } from "./MiniPullRequests";
import { MiniUpdate } from "./MiniUpdate";
import { MiniUsage } from "./MiniUsage";
import { MiniWindows } from "./MiniWindows";
import { useProjectScopeGroups } from "./useProjectScopeGroups";
import { notifyWindowActionFailure, openNewDesktopWindow } from "./windowActions";

type MiniTab = "windows" | "pullRequests" | "usage" | "update";

/** The main window's compact stand-in for the app shell while Mini Mode is on. */
export function MiniMainWindow() {
  const [bridge] = useState(desktopWindowsBridge);
  return bridge === null ? null : <MiniMainWindowContent bridge={bridge} />;
}

function MiniMainWindowContent({ bridge }: { readonly bridge: DesktopWindowsBridge }) {
  const gt = useGT();
  const router = useRouter();
  const windowsState = useDesktopWindowsState();
  const updateState = useDesktopUpdateState();
  const pullRequestsSupported = usePullRequestsSupported();
  const { groupsForKeys } = useProjectScopeGroups();
  const multiWindowEnabled = windowsState?.multiWindowEnabled !== false;

  const expand = () => {
    bridge.setMiniMode(false).catch((cause: unknown) => {
      notifyWindowActionFailure(gt("Couldn't leave Mini Mode"), cause);
    });
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the router: the panel shows no pages, so going to one (a search result, Settings) needs the full window
  useEffect(
    () =>
      router.subscribe("onBeforeNavigate", ({ pathChanged }) => {
        if (pathChanged) void bridge.setMiniMode(false);
      }),
    [bridge, router],
  );

  return (
    <CommandPalette>
      <MiniPanel
        pullRequestsSupported={pullRequestsSupported}
        updateAvailable={
          updateState !== null && resolveDesktopUpdateButtonAction(updateState) !== "none"
        }
        onSearch={() => openCommandPalette()}
        onExpand={expand}
        // Off in Settings, the main process refuses new windows, so don't offer one.
        onNewWindow={multiWindowEnabled ? () => openNewDesktopWindow(bridge) : undefined}
        tabs={{
          windows: (
            <MiniWindows
              windows={windowsState?.windows.filter((window) => !window.isMain) ?? null}
              projectsFor={groupsForKeys}
              onFocusWindow={(windowId) => {
                bridge.focus(windowId).catch((cause: unknown) => {
                  notifyWindowActionFailure(gt("Couldn't focus the window"), cause);
                });
              }}
            />
          ),
          pullRequests: <MiniPullRequests />,
          usage: <MiniUsage />,
          update: <MiniUpdate />,
        }}
      />
    </CommandPalette>
  );
}

/** One top bar, tabs on the left and actions on the right, over one tab's content. */
export function MiniPanel({
  pullRequestsSupported,
  updateAvailable,
  onSearch,
  onExpand,
  onNewWindow,
  tabs,
}: {
  readonly pullRequestsSupported: boolean;
  readonly updateAvailable: boolean;
  readonly onSearch: () => void;
  readonly onExpand: () => void;
  /** Omitted while multiple windows are turned off. */
  readonly onNewWindow?: (() => void) | undefined;
  /** Only the showing tab's content mounts. */
  readonly tabs: Readonly<Record<MiniTab, ReactNode>>;
}) {
  const gt = useGT();
  const [tab, setTab] = useState<MiniTab>("usage");
  const tabItem = (id: MiniTab, label: string, icon: ReactNode) => (
    <SidebarHeaderIconButton
      label={label}
      isActive={tab === id}
      aria-current={tab === id ? "page" : undefined}
      onClick={() => setTab(id)}
    >
      {icon}
    </SidebarHeaderIconButton>
  );
  return (
    <SidebarProvider className="h-dvh min-h-0">
      <div className="flex min-w-0 flex-1 flex-col bg-sidebar text-sidebar-foreground">
        <header className="drag-region flex h-(--workspace-topbar-height) shrink-0 items-center gap-0.5 px-(--sidebar-content-inset) wco:pr-(--workspace-native-controls-inset)">
          <nav aria-label={gt("Mini Mode tabs")} className="flex items-center gap-0.5">
            {tabItem(
              "windows",
              gt("Windows", { $context: "Mini Mode tab listing the app's open windows" }),
              <LayersIcon />,
            )}
            {pullRequestsSupported
              ? tabItem("pullRequests", gt("Pull requests"), <PullRequestGlyph.pullRequest />)
              : null}
            {tabItem(
              "usage",
              gt("Usage", { $context: "Mini Mode tab showing usage limits" }),
              <ChartNoAxesColumnIcon />,
            )}
            <span className="relative">
              {tabItem(
                "update",
                gt("Update", { $context: "Mini Mode tab about app updates" }),
                <CircleArrowUpIcon />,
              )}
              {updateAvailable ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-primary"
                />
              ) : null}
            </span>
          </nav>
          <span className="flex-1" />
          <SidebarHeaderIconButton label={gt("Search")} onClick={onSearch}>
            <SearchIcon />
          </SidebarHeaderIconButton>
          {onNewWindow === undefined ? null : (
            <SidebarHeaderIconButton label={gt("New Window")} onClick={onNewWindow}>
              <AppWindowIcon />
            </SidebarHeaderIconButton>
          )}
          <SidebarHeaderIconButton
            label={gt("Expand", { $context: "button, leaves Mini Mode for the full window" })}
            onClick={onExpand}
          >
            <Maximize2Icon />
          </SidebarHeaderIconButton>
        </header>
        <main className="min-h-0 flex-1">
          <ScrollArea hideScrollbars scrollFade>
            {tabs[tab]}
          </ScrollArea>
        </main>
      </div>
    </SidebarProvider>
  );
}
