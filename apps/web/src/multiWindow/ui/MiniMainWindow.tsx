import { useRouter } from "@tanstack/react-router";
import type { DesktopWindowsBridge } from "@t3tools/contracts";
import {
  AppWindowIcon,
  ChartNoAxesColumnIcon,
  CircleArrowUpIcon,
  Maximize2Icon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { CommandPalette } from "../../components/CommandPalette";
import { resolveDesktopUpdateButtonAction } from "../../components/desktopUpdate.logic";
import { PullRequestGlyph } from "../../components/pullRequest/pullRequestIcons";
import { SidebarUtilityItem } from "../../components/sidebar/SidebarChrome";
import { SidebarHeaderIconButton } from "../../components/sidebar/SidebarThreadHeader";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarProvider,
} from "../../components/ui/sidebar";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { usePullRequestsSupported } from "../../state/environments";
import { desktopWindowsBridge } from "../windowContext";
import { useDesktopWindowsState } from "../windowsState";
import { MiniPullRequests } from "./MiniPullRequests";
import { MiniSettings } from "./MiniSettings";
import { MiniUpdate } from "./MiniUpdate";
import { MiniUsage } from "./MiniUsage";
import { MiniWindows } from "./MiniWindows";
import { useProjectScopeGroups } from "./useProjectScopeGroups";
import { notifyWindowActionFailure, openNewDesktopWindow } from "./windowActions";

export type MiniTab = "windows" | "settings" | "pullRequests" | "usage" | "update";

/** The main window's compact stand-in for the app shell while Mini Mode is on. */
export function MiniMainWindow() {
  const [bridge] = useState(desktopWindowsBridge);
  return bridge === null ? null : <MiniMainWindowContent bridge={bridge} />;
}

function MiniMainWindowContent({ bridge }: { readonly bridge: DesktopWindowsBridge }) {
  const router = useRouter();
  const windowsState = useDesktopWindowsState();
  const updateState = useDesktopUpdateState();
  const pullRequestsSupported = usePullRequestsSupported();
  const { groupsForKeys } = useProjectScopeGroups();
  const [tab, setTab] = useState<MiniTab>("usage");
  const multiWindowEnabled = windowsState?.multiWindowEnabled !== false;

  const expand = () => {
    bridge.setMiniMode(false).catch((cause: unknown) => {
      notifyWindowActionFailure("Couldn't leave Mini Mode", cause);
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
        tab={tab}
        onTabChange={setTab}
        pullRequestsSupported={pullRequestsSupported}
        updateAvailable={
          updateState !== null && resolveDesktopUpdateButtonAction(updateState) !== "none"
        }
        onSearch={() => openCommandPalette()}
        onExpand={expand}
        // Off in Settings, the main process refuses new windows, so don't offer one.
        onNewWindow={multiWindowEnabled ? () => openNewDesktopWindow(bridge) : undefined}
      >
        {tab === "windows" ? (
          <MiniWindows
            windows={windowsState?.windows.filter((window) => !window.isMain) ?? null}
            projectsFor={groupsForKeys}
            onFocusWindow={(windowId) => {
              bridge.focus(windowId).catch((cause: unknown) => {
                notifyWindowActionFailure("Couldn't focus the window", cause);
              });
            }}
          />
        ) : tab === "settings" ? (
          <MiniSettings
            multiWindowEnabled={multiWindowEnabled}
            onMultiWindowEnabledChange={(enabled) => {
              bridge.setMultiWindowEnabled(enabled).catch((cause: unknown) => {
                notifyWindowActionFailure("Couldn't change multiple windows", cause);
              });
            }}
            onOpenSettings={() => void router.navigate({ to: "/settings" })}
          />
        ) : tab === "pullRequests" ? (
          <MiniPullRequests />
        ) : tab === "update" ? (
          <MiniUpdate />
        ) : (
          <MiniUsage />
        )}
      </MiniPanel>
    </CommandPalette>
  );
}

/** The sidebar's top bar and bottom bar around one tab's content; the tabs never share the panel. */
export function MiniPanel({
  tab,
  onTabChange,
  pullRequestsSupported,
  updateAvailable,
  onSearch,
  onExpand,
  onNewWindow,
  children,
}: {
  readonly tab: MiniTab;
  readonly onTabChange: (tab: MiniTab) => void;
  readonly pullRequestsSupported: boolean;
  readonly updateAvailable: boolean;
  readonly onSearch: () => void;
  readonly onExpand: () => void;
  /** Omitted while multiple windows are turned off. */
  readonly onNewWindow?: (() => void) | undefined;
  readonly children: ReactNode;
}) {
  const tabItem = (id: MiniTab, label: string, icon: ReactNode) => (
    <SidebarUtilityItem
      icon={icon}
      label={label}
      isActive={tab === id}
      onClick={() => onTabChange(id)}
    />
  );
  return (
    <SidebarProvider className="h-dvh min-h-0">
      <div className="flex min-w-0 flex-1 flex-col bg-sidebar text-sidebar-foreground">
        <header className="drag-region flex h-(--workspace-topbar-height) shrink-0 items-center px-(--sidebar-content-inset) wco:pr-(--workspace-native-controls-inset)">
          <SidebarMenuButton className="w-auto" onClick={onSearch}>
            <SearchIcon />
            <span>Search</span>
          </SidebarMenuButton>
          <span className="flex-1" />
          {onNewWindow === undefined ? null : (
            <SidebarHeaderIconButton label="New Window" onClick={onNewWindow}>
              <AppWindowIcon />
            </SidebarHeaderIconButton>
          )}
          <SidebarHeaderIconButton label="Expand" onClick={onExpand}>
            <Maximize2Icon />
          </SidebarHeaderIconButton>
        </header>
        <main className="min-h-0 flex-1">
          <ScrollArea hideScrollbars scrollFade>
            {children}
          </ScrollArea>
        </main>
        <SidebarFooter>
          <SidebarMenu aria-label="Mini Mode tabs" className="flex-row items-center">
            {tabItem("windows", "Windows", <AppWindowIcon />)}
            {tabItem("settings", "Settings", <SettingsIcon />)}
            {pullRequestsSupported
              ? tabItem("pullRequests", "Pull requests", <PullRequestGlyph.pullRequest />)
              : null}
            {tabItem("usage", "Usage", <ChartNoAxesColumnIcon />)}
            <span className="flex-1" />
            <span className="relative">
              {tabItem("update", "Update", <CircleArrowUpIcon />)}
              {updateAvailable ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-primary"
                />
              ) : null}
            </span>
          </SidebarMenu>
        </SidebarFooter>
      </div>
    </SidebarProvider>
  );
}
