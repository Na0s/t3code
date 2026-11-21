import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { isListedThreadLineage, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import {
  CalendarClockIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MaximizeIcon,
  MenuIcon,
  MinimizeIcon,
  PinIcon,
  PinOffIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useState, type Ref } from "react";

import type { MessageResolver } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { useThreadSearch } from "../../state/queries";
import { RelativeTime } from "../RelativeTime";
import { resolveThreadStatusPill, searchSidebarThreads } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "../ui/sidebar";
import { BotIcon } from "./BotIcon";
import {
  buildBotThreadTree,
  describeBotGroupStatus,
  IDLE_BOT_ACTIVITY,
  isBotListedThread,
  type Bot,
  type BotActivity,
  type BotGroupStatus,
  type BotThread,
  type BotThreadNode,
} from "./BotShell.logic";

export interface BotWindowControls {
  readonly pinned: boolean;
  readonly expanded: boolean;
  readonly onTogglePinned: () => void;
  readonly onToggleExpanded: () => void;
}

const GROUP_STATUS_CLASS: Record<BotGroupStatus["kind"], string> = {
  attention: "text-warning-foreground",
  working: "text-info-foreground",
  unread: "text-success-foreground",
  idle: "text-muted-foreground",
};

/** The hamburger view: the active bot's conversations, then the other bots, folded. */
export function BotThreadList(props: {
  readonly bots: ReadonlyArray<Bot>;
  readonly activeBot: Bot;
  readonly threadsByBotKey: ReadonlyMap<string, ReadonlyArray<BotThread>>;
  readonly activityByKey: ReadonlyMap<string, BotActivity>;
  readonly selectedThreadId: ThreadId | null;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly searchInputRef: Ref<HTMLInputElement>;
  /** Hamburger and search above the list, when the header leaves them out. */
  readonly showNav: boolean;
  readonly onToggleList: () => void;
  readonly onFocusSearch: () => void;
  readonly onSelectThread: (bot: Bot, threadId: ThreadId) => void;
  readonly onOpenRoutines: () => void;
  readonly onOpenSettings: (bot: Bot) => void;
  readonly windowControls: BotWindowControls | null;
}) {
  const { activeBot, threadsByBotKey, searchQuery, searchInputRef, onSearchQueryChange } = props;
  const gt = useGT();
  const messages = useMessages();
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [activeCollapsed, setActiveCollapsed] = useState(false);
  const searching = searchQuery.trim().length > 0;
  const otherBots = props.bots.filter((bot) => bot.key !== activeBot.key);
  const activeThreads = threadsByBotKey.get(activeBot.key) ?? [];
  const activeTree = buildBotThreadTree(activeThreads, activeBot.settings.mainThreadId ?? null);
  const activeThreadCount = activeThreads.filter(isBotListedThread).length;
  const toggleExpanded = (key: string) =>
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-sidebar">
      <div className="flex shrink-0 flex-col gap-2 p-2">
        {props.showNav ? (
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={gt("Hide threads")}
              aria-expanded
              onClick={props.onToggleList}
            >
              <MenuIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={gt("Search threads")}
              onClick={props.onFocusSearch}
            >
              <SearchIcon />
            </Button>
          </div>
        ) : null}
        <Input
          ref={searchInputRef}
          type="search"
          size="sm"
          placeholder={gt("Search threads and messages")}
          aria-label={gt("Search threads and messages")}
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || searchQuery.length === 0) return;
            event.preventDefault();
            onSearchQueryChange("");
          }}
        />
      </div>
      <SidebarContent>
        {searching ? (
          <BotThreadSearchResults
            bots={props.bots}
            threadsByBotKey={threadsByBotKey}
            query={searchQuery}
            selectedThreadId={props.selectedThreadId}
            onSelectThread={props.onSelectThread}
          />
        ) : (
          <>
            <SidebarGroup>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    aria-expanded={!activeCollapsed}
                    onClick={() => setActiveCollapsed((collapsed) => !collapsed)}
                  >
                    <BotIcon project={activeBot.project} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-sidebar-foreground">
                      {activeBot.project.title}
                    </span>
                    {activeCollapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
                    <span className="text-xs font-normal">
                      {gt("{count, plural, one {{count} thread} other {{count} threads}}", {
                        count: activeThreadCount,
                      })}
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {activeCollapsed ? null : (
                  <BotThreadTreeRows
                    bot={activeBot}
                    nodes={activeTree}
                    threads={activeThreads}
                    selectedThreadId={props.selectedThreadId}
                    onSelectThread={props.onSelectThread}
                  />
                )}
              </SidebarMenu>
            </SidebarGroup>
            {otherBots.length > 0 ? (
              <SidebarGroup>
                <SidebarMenu>
                  {otherBots.map((bot) => {
                    const expanded = expandedKeys.has(bot.key);
                    const status = describeBotGroupStatus(
                      props.activityByKey.get(bot.key) ?? IDLE_BOT_ACTIVITY,
                      messages,
                    );
                    const threads = threadsByBotKey.get(bot.key) ?? [];
                    return (
                      <BotGroup
                        key={bot.key}
                        bot={bot}
                        status={status}
                        expanded={expanded}
                        onToggle={() => toggleExpanded(bot.key)}
                      >
                        {expanded ? (
                          <BotThreadTreeRows
                            bot={bot}
                            nodes={buildBotThreadTree(threads, bot.settings.mainThreadId ?? null)}
                            threads={threads}
                            selectedThreadId={null}
                            onSelectThread={props.onSelectThread}
                          />
                        ) : null}
                      </BotGroup>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroup>
            ) : null}
            <BotArchivedCount bots={props.bots} />
          </>
        )}
      </SidebarContent>
      <SidebarFooter>
        <div className="flex flex-wrap items-center gap-0.5">
          <Button variant="ghost-muted" size="xs" onClick={props.onOpenRoutines}>
            <CalendarClockIcon />
            <T>Routines</T>
          </Button>
          <Button variant="ghost-muted" size="xs" onClick={() => props.onOpenSettings(activeBot)}>
            <SettingsIcon />
            <T>Settings</T>
          </Button>
          {props.windowControls ? (
            <>
              <Button
                variant="ghost-muted"
                size="xs"
                aria-pressed={props.windowControls.pinned}
                onClick={props.windowControls.onTogglePinned}
              >
                {props.windowControls.pinned ? <PinOffIcon /> : <PinIcon />}
                {props.windowControls.pinned
                  ? gt("Unpin", { $context: "window" })
                  : gt("Pin", { $context: "window" })}
              </Button>
              <Button
                variant="ghost-muted"
                size="xs"
                aria-pressed={props.windowControls.expanded}
                onClick={props.windowControls.onToggleExpanded}
              >
                {props.windowControls.expanded ? <MinimizeIcon /> : <MaximizeIcon />}
                {props.windowControls.expanded
                  ? gt("Narrow", { $context: "window size" })
                  : gt("Expand", { $context: "window size" })}
              </Button>
            </>
          ) : null}
        </div>
      </SidebarFooter>
    </div>
  );
}

function BotGroup(props: {
  readonly bot: Bot;
  readonly status: BotGroupStatus;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton aria-expanded={props.expanded} onClick={props.onToggle}>
          <BotIcon project={props.bot.project} size="sm" />
          <span className="min-w-0 truncate text-sidebar-foreground">
            {props.bot.project.title}
          </span>
          {props.expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          <span
            className={cn("ml-auto text-xs font-normal", GROUP_STATUS_CLASS[props.status.kind])}
          >
            {props.status.label}
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      {props.children}
    </>
  );
}

function threadPreview(
  thread: BotThread,
  threads: ReadonlyArray<BotThread>,
  resolve: MessageResolver,
): string | null {
  const parentId = thread.lineage.parentThreadId;
  if (thread.lineage.relationshipToParent === "fork" && parentId !== null) {
    const parent = threads.find((candidate) => candidate.id === parentId);
    if (parent) return resolve(msg("Spun off from {title}", { title: parent.title }));
  }
  const text = thread.source.latestVisibleMessage?.text.trim() ?? "";
  return text.length === 0 ? null : (text.split("\n", 1)[0] ?? null);
}

function ThreadStatusDot(props: { readonly thread: BotThread }) {
  const messages = useMessages();
  const pill = resolveThreadStatusPill({ thread: props.thread });
  if (pill === null) return <span aria-hidden="true" className="size-1.5 shrink-0" />;
  return (
    <span
      role="img"
      aria-label={messages(pill.label)}
      className={cn("size-1.5 shrink-0 rounded-full", pill.dotClass)}
    />
  );
}

function BotThreadTreeRows(props: {
  readonly bot: Bot;
  readonly nodes: ReadonlyArray<BotThreadNode<BotThread>>;
  readonly threads: ReadonlyArray<BotThread>;
  readonly selectedThreadId: ThreadId | null;
  readonly onSelectThread: (bot: Bot, threadId: ThreadId) => void;
}) {
  const messages = useMessages();
  if (props.nodes.length === 0) {
    return (
      <li className="px-3 py-1 text-xs text-muted-foreground">
        <T>No conversations yet.</T>
      </li>
    );
  }
  return props.nodes.map((node) => {
    const { thread } = node;
    const preview = threadPreview(thread, props.threads, messages);
    return (
      <SidebarMenuItem key={thread.id}>
        <SidebarMenuButton
          size="lg"
          isActive={thread.id === props.selectedThreadId}
          onClick={() => props.onSelectThread(props.bot, thread.id)}
        >
          <ThreadStatusDot thread={thread} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sidebar-foreground">{thread.title}</span>
            {preview ? (
              <span className="truncate text-xs font-normal text-muted-foreground">{preview}</span>
            ) : null}
          </span>
          <span className="shrink-0 self-start text-2xs font-normal text-muted-foreground">
            <RelativeTime timestamp={thread.latestUserMessageAt ?? thread.updatedAt} />
          </span>
        </SidebarMenuButton>
        {node.children.length > 0 ? (
          <BotThreadSubRows
            bot={props.bot}
            nodes={node.children}
            selectedThreadId={props.selectedThreadId}
            onSelectThread={props.onSelectThread}
          />
        ) : null}
      </SidebarMenuItem>
    );
  });
}

function BotThreadSubRows(props: {
  readonly bot: Bot;
  readonly nodes: ReadonlyArray<BotThreadNode<BotThread>>;
  readonly selectedThreadId: ThreadId | null;
  readonly onSelectThread: (bot: Bot, threadId: ThreadId) => void;
}) {
  return (
    <SidebarMenuSub>
      {props.nodes.map((node) => (
        <SidebarMenuSubItem key={node.thread.id}>
          <SidebarMenuSubButton
            render={<button type="button" />}
            isActive={node.thread.id === props.selectedThreadId}
            onClick={() => props.onSelectThread(props.bot, node.thread.id)}
          >
            <ThreadStatusDot thread={node.thread} />
            <span>{node.thread.title}</span>
          </SidebarMenuSubButton>
          {node.children.length > 0 ? (
            <BotThreadSubRows
              bot={props.bot}
              nodes={node.children}
              selectedThreadId={props.selectedThreadId}
              onSelectThread={props.onSelectThread}
            />
          ) : null}
        </SidebarMenuSubItem>
      ))}
    </SidebarMenuSub>
  );
}

function BotThreadSearchResults(props: {
  readonly bots: ReadonlyArray<Bot>;
  readonly threadsByBotKey: ReadonlyMap<string, ReadonlyArray<BotThread>>;
  readonly query: string;
  readonly selectedThreadId: ThreadId | null;
  readonly onSelectThread: (bot: Bot, threadId: ThreadId) => void;
}) {
  const gt = useGT();
  const environmentIds = [
    ...new Set(props.bots.map((bot) => bot.project.environmentId)),
  ].toSorted();
  const search = useThreadSearch(environmentIds, props.query, {
    projectIds: props.bots.map((bot) => bot.project.id),
  });
  const botByThreadKey = new Map<string, Bot>();
  const threads: BotThread[] = [];
  for (const bot of props.bots) {
    for (const thread of props.threadsByBotKey.get(bot.key) ?? []) {
      if (!isBotListedThread(thread)) continue;
      threads.push(thread);
      botByThreadKey.set(
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
        bot,
      );
    }
  }
  const { titleMatches, contentMatches } = searchSidebarThreads(
    threads,
    props.query,
    new Set(search.matches.map(threadSearchMatchKey)),
  );
  const results = [...titleMatches, ...contentMatches];
  return (
    <SidebarGroup>
      <SidebarMenu>
        {results.length === 0 ? (
          <li className="px-3 py-1 text-xs text-muted-foreground">
            {search.isPending ? gt("Searching…") : gt("No matching threads.")}
          </li>
        ) : (
          results.map((thread) => {
            const bot = botByThreadKey.get(
              threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
            );
            if (!bot) return null;
            return (
              <SidebarMenuItem key={`${thread.environmentId}:${thread.id}`}>
                <SidebarMenuButton
                  size="lg"
                  isActive={thread.id === props.selectedThreadId}
                  onClick={() => props.onSelectThread(bot, thread.id)}
                >
                  <BotIcon project={bot.project} size="sm" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sidebar-foreground">{thread.title}</span>
                    <span className="truncate text-xs font-normal text-muted-foreground">
                      {bot.project.title}
                    </span>
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}

function BotArchivedCount(props: { readonly bots: ReadonlyArray<Bot> }) {
  const gt = useGT();
  const environmentIds: EnvironmentId[] = [
    ...new Set(props.bots.map((bot) => bot.project.environmentId)),
  ].toSorted();
  const { snapshots } = useArchivedThreadSnapshots(environmentIds);
  const botProjectKeys = new Set(
    props.bots.map((bot) => `${bot.project.environmentId}:${bot.project.id}`),
  );
  let count = 0;
  for (const { environmentId, snapshot } of snapshots) {
    for (const thread of snapshot.threads) {
      if (
        isListedThreadLineage(thread.lineage) &&
        botProjectKeys.has(`${environmentId}:${thread.projectId}`)
      ) {
        count += 1;
      }
    }
  }
  if (count === 0) return null;
  return (
    <div className="px-2 pb-2">
      <Button variant="ghost-muted" size="xs" render={<Link to="/settings/archived" />}>
        {gt("Archived ({count})", { count })}
      </Button>
    </div>
  );
}
