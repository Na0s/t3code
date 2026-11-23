import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { msg, T, useGT, useMessages } from "gt-react";
import { useRef, useState } from "react";

import { DraftId } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { m } from "../../i18n/messages";
import { useClientSettings } from "../../hooks/useSettings";
import { desktopWindowsBridge, readDesktopWindowContext } from "../../multiWindow/windowContext";
import {
  useAllEnvironmentProjectSnapshotsReady,
  useBotQuietThreadShells,
} from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useUiStateStore } from "../../uiStateStore";
import { resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { BotChatPane } from "./BotChatPane";
import { BotHeader } from "./BotHeader";
import {
  nextBotOrder,
  resolveBotActivity,
  resolveBotDefaultThreadId,
  type Bot,
  type BotRouteSearch,
  type BotThread,
} from "./BotShell.logic";
import { BotThreadList, type BotWindowControls } from "./BotThreadList";
import { useBots } from "./botState";
import { NewBotDialog } from "./NewBotDialog";

/** Where the thread list stops covering the chat and stays open beside it. */
const MEDIUM_MIN_WIDTH = 720;

const EMPTY_THREADS: ReadonlyArray<BotThread> = [];

function reportWindowFailure(title: string, cause: unknown) {
  toastManager.add({
    type: "error",
    title,
    ...(cause instanceof Error ? { description: cause.message } : {}),
  });
}

/** The `/bot` route: T3_BOT's window, laid out as the A3 bot stack. */
export function BotShell(props: { readonly search: BotRouteSearch }) {
  const { search } = props;
  const navigate = useNavigate();
  const gt = useGT();
  const messages = useMessages();
  const bots = useBots();
  const projectsReady = useAllEnvironmentProjectSnapshotsReady();
  const shells = useBotQuietThreadShells();
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const handleNewThread = useNewThreadHandler();
  const isMedium = useMediaQuery({ min: MEDIUM_MIN_WIDTH });
  const [narrowListOpen, setNarrowListOpen] = useState(false);
  const [mediumListHidden, setMediumListHidden] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [newBotOpen, setNewBotOpen] = useState(false);
  // Only the bot window carries bot state; elsewhere the route has no window controls.
  const botWindowState = readDesktopWindowContext()?.bot ?? null;
  const [pinned, setPinned] = useState(botWindowState?.pinned ?? false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const botKeys = new Set(bots.map((bot) => bot.key));
  const threadsByBotKey = new Map<string, BotThread[]>();
  for (const shell of shells) {
    const botKey = scopedProjectKey(scopeProjectRef(shell.environmentId, shell.projectId));
    if (!botKeys.has(botKey)) continue;
    const thread: BotThread = {
      ...shell,
      lastVisitedAt:
        resolveThreadLastVisitedAt(
          shell.lastVisitedAt,
          localLastVisitedAtById[scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id))],
        ) ?? null,
    };
    const threads = threadsByBotKey.get(botKey);
    if (threads) threads.push(thread);
    else threadsByBotKey.set(botKey, [thread]);
  }
  const activityByKey = new Map(
    bots.map((bot) => [
      bot.key,
      resolveBotActivity(threadsByBotKey.get(bot.key) ?? EMPTY_THREADS, messages),
    ]),
  );
  const activeBot = bots.find((bot) => bot.key === search.bot) ?? bots[0] ?? null;
  const activeThreads = activeBot ? (threadsByBotKey.get(activeBot.key) ?? EMPTY_THREADS) : [];
  const draftId = search.draftId === undefined ? null : DraftId.make(search.draftId);
  const selectedThreadId =
    draftId !== null || activeBot === null
      ? null
      : search.thread !== undefined
        ? ThreadId.make(search.thread)
        : resolveBotDefaultThreadId(activeBot, activeThreads);
  const listVisible = isMedium ? !mediumListHidden : narrowListOpen;
  const narrowListShown = !isMedium && narrowListOpen;

  const toggleList = () => {
    if (isMedium) setMediumListHidden((hidden) => !hidden);
    else setNarrowListOpen((open) => !open);
  };
  const focusSearch = () => {
    if (!listVisible) toggleList();
    // The input mounts with the list, a frame after this state change.
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  };
  const selectBot = (bot: Bot, threadId?: ThreadId) => {
    void navigate({
      to: "/bot",
      search: threadId === undefined ? { bot: bot.key } : { bot: bot.key, thread: threadId },
    });
  };
  const selectThread = (bot: Bot, threadId: ThreadId) => {
    if (!isMedium) setNarrowListOpen(false);
    void navigate({ to: "/bot", search: { bot: bot.key, thread: threadId } });
  };
  const startNewThread = async () => {
    if (activeBot === null) return;
    const botKey = activeBot.key;
    const opened = await handleNewThread(
      scopeProjectRef(activeBot.project.environmentId, activeBot.project.id),
      { navigate: false },
    ).catch((cause: unknown) => {
      reportWindowFailure(m(msg("Could not start a conversation")), cause);
      return null;
    });
    if (opened === null) return;
    setNarrowListOpen(false);
    void navigate({ to: "/bot", search: { bot: botKey, draftId: opened.draftId } });
  };
  const openRoutines = () => {
    void navigate({
      to: "/settings/scheduled-tasks",
      search: activeBot ? { environmentId: activeBot.project.environmentId } : {},
    });
  };
  const openSettings = (bot: Bot) => {
    void navigate({
      to: "/projects/$projectKey",
      params: { projectKey: deriveLogicalProjectKeyFromSettings(bot.project, groupingSettings) },
    });
  };

  const botWindow = botWindowState === null ? null : (desktopWindowsBridge()?.bot ?? null);
  const windowControls: BotWindowControls | null =
    botWindow === null
      ? null
      : {
          pinned,
          expanded: isMedium,
          onTogglePinned: () => {
            const next = !pinned;
            setPinned(next);
            botWindow.setPinned(next).catch((cause: unknown) => {
              setPinned(!next);
              reportWindowFailure(
                next ? m(msg("Could not pin the window")) : m(msg("Could not unpin the window")),
                cause,
              );
            });
          },
          onToggleExpanded: () => {
            botWindow.setSize(isMedium ? "narrow" : "medium").catch((cause: unknown) => {
              reportWindowFailure(m(msg("Could not resize the window")), cause);
            });
          },
        };

  const newBotDialog = (
    <NewBotDialog
      open={newBotOpen}
      onOpenChange={setNewBotOpen}
      environmentId={activeBot?.project.environmentId ?? primaryEnvironmentId}
      order={nextBotOrder(bots)}
      onCreated={(botKey) => {
        void navigate({ to: "/bot", search: { bot: botKey } });
      }}
    />
  );

  if (activeBot === null) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden">
        {projectsReady ? <BotEmptyState onCreate={() => setNewBotOpen(true)} /> : null}
        {newBotDialog}
      </SidebarInset>
    );
  }

  const selectedThread =
    selectedThreadId === null
      ? null
      : (activeThreads.find((thread) => thread.id === selectedThreadId) ?? null);
  const subtitle = narrowListShown
    ? gt("Threads")
    : draftId !== null
      ? gt("New conversation")
      : (selectedThread?.title ?? "");
  const threadList = (showNav: boolean) => (
    <BotThreadList
      bots={bots}
      activeBot={activeBot}
      threadsByBotKey={threadsByBotKey}
      activityByKey={activityByKey}
      selectedThreadId={selectedThreadId}
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
      searchInputRef={searchInputRef}
      showNav={showNav}
      onToggleList={toggleList}
      onFocusSearch={focusSearch}
      onSelectThread={selectThread}
      onOpenRoutines={openRoutines}
      onOpenSettings={openSettings}
      windowControls={windowControls}
    />
  );

  return (
    <SidebarInset className="h-dvh min-h-0 flex-row overflow-hidden">
      {isMedium && listVisible ? (
        <aside className="flex w-72 shrink-0 flex-col border-r border-border">
          {threadList(true)}
        </aside>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <BotHeader
          bots={bots}
          activeBot={activeBot}
          activityByKey={activityByKey}
          subtitle={subtitle}
          showNav={!(isMedium && listVisible)}
          listOpen={narrowListShown}
          onToggleList={toggleList}
          onSearch={focusSearch}
          onNewThread={() => void startNewThread()}
          onSelectBot={selectBot}
          onNewBot={() => setNewBotOpen(true)}
        />
        <div className="relative flex min-h-0 flex-1 flex-col">
          {/* Stays mounted under the narrow thread list, so closing the list is instant. */}
          <div className="flex min-h-0 flex-1 flex-col" inert={narrowListShown}>
            <BotChatPane
              bot={activeBot}
              threadId={selectedThreadId}
              draftId={draftId}
              onNewThread={() => void startNewThread()}
            />
          </div>
          {narrowListShown ? (
            <div className="absolute inset-0 z-20 flex flex-col">{threadList(false)}</div>
          ) : null}
        </div>
      </div>
      {newBotDialog}
    </SidebarInset>
  );
}

function BotEmptyState(props: { readonly onCreate: () => void }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>
          <T>No bots yet</T>
        </EmptyTitle>
        <EmptyDescription>
          <T>
            A bot is a persistent assistant built on T3. It keeps its own folder for guidance and
            memory, runs routines on a schedule, and every conversation with it is a thread you can
            spin off, search, and come back to.
          </T>
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={props.onCreate}>
          <T>Create a bot</T>
        </Button>
      </EmptyContent>
    </Empty>
  );
}
