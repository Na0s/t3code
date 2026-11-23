import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { resolveThreadActivityTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import {
  isListedThreadLineage,
  type BotSettings,
  type EnvironmentId,
  type ProjectIconColor,
  type ThreadId,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import { deriveProjectIdentity } from "../../projectIdentity";
import {
  hasUnseenCompletion,
  resolveSidebarFolderDot,
  resolveSidebarRowStatus,
  type SidebarThreadStatus,
} from "../Sidebar.logic";

export interface Bot {
  /** The project's scoped key; the `bot` search param. */
  readonly key: string;
  readonly project: EnvironmentProject;
  readonly settings: BotSettings;
}

/** A bot thread with the visited watermark the sidebar would use for it. */
export type BotThread = EnvironmentThreadShell;

export type BotsByEnvironment = ReadonlyMap<
  EnvironmentId,
  Readonly<Record<string, BotSettings | undefined>>
>;

/** Bot projects in their configured order, then by name. */
export function listBots(
  projects: ReadonlyArray<EnvironmentProject>,
  botsByEnvironment: BotsByEnvironment,
): Bot[] {
  const bots: Bot[] = [];
  for (const project of projects) {
    if (project.isBot !== true || project.archivedAt != null) continue;
    const settings = botsByEnvironment.get(project.environmentId)?.[project.id];
    if (settings === undefined) continue;
    bots.push({
      key: scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      project,
      settings,
    });
  }
  return bots.toSorted(
    (left, right) =>
      (left.settings.order ?? Number.POSITIVE_INFINITY) -
        (right.settings.order ?? Number.POSITIVE_INFINITY) ||
      left.project.title.localeCompare(right.project.title) ||
      (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
  );
}

/** The `order` a new bot takes: after every existing bot. */
export function nextBotOrder(bots: ReadonlyArray<Bot>): number {
  let max = -1;
  for (const bot of bots) {
    if (bot.settings.order !== undefined && bot.settings.order > max) max = bot.settings.order;
  }
  return Math.max(max + 1, bots.length);
}

export function botColor(
  project: Pick<EnvironmentProject, "title" | "projectIcon">,
): ProjectIconColor {
  const icon = project.projectIcon;
  if (icon?.kind === "monogram" || icon?.kind === "lucide") return icon.color;
  return deriveProjectIdentity(project.title).color;
}

/** Threads the bot's lists show: not archived, and not living inside another thread's view. */
export function isBotListedThread(thread: Pick<BotThread, "archivedAt" | "lineage">): boolean {
  return thread.archivedAt === null && isListedThreadLineage(thread.lineage);
}

export type BotAttentionKind = "approval" | "input" | "request" | "limited" | "failed";

const ATTENTION_ORDER: ReadonlyArray<BotAttentionKind> = [
  "approval",
  "input",
  "request",
  "limited",
  "failed",
];

const BOT_ATTENTION_LABEL: Record<BotAttentionKind, string> = {
  approval: msg("Needs approval"),
  input: msg("Needs input"),
  request: msg("Guest request"),
  limited: msg("Usage limit"),
  failed: msg("Failed", { $context: "bot status" }),
};

export interface BotAttention {
  readonly kind: BotAttentionKind;
  readonly label: string;
  readonly threadId: ThreadId;
}

export type BotHealth = "attention" | "failed" | "unread" | "working" | "idle";

export interface BotActivity {
  readonly health: BotHealth;
  /** The most urgent thread waiting on the user, or one that failed since it was opened. */
  readonly attention: BotAttention | null;
  readonly unreadCount: number;
  readonly workingCount: number;
  readonly latestActivityMs: number;
}

export const IDLE_BOT_ACTIVITY: BotActivity = {
  health: "idle",
  attention: null,
  unreadCount: 0,
  workingCount: 0,
  latestActivityMs: Number.NEGATIVE_INFINITY,
};

function isAttentionStatus(status: SidebarThreadStatus): status is BotAttentionKind {
  return (ATTENTION_ORDER as ReadonlyArray<SidebarThreadStatus>).includes(status);
}

function activityMs(thread: BotThread): number {
  const timestamp = resolveThreadActivityTimestamp(thread);
  const ms = timestamp === null ? Number.NaN : Date.parse(timestamp);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** A bot's status from its listed threads, by the main sidebar's row and folder rules. */
export function resolveBotActivity(
  threads: ReadonlyArray<BotThread>,
  resolve: MessageResolver = m,
): BotActivity {
  const listed = threads.filter(isBotListedThread);
  if (listed.length === 0) return IDLE_BOT_ACTIVITY;
  let attention: BotAttention | null = null;
  let unreadCount = 0;
  let workingCount = 0;
  let latestActivityMs = Number.NEGATIVE_INFINITY;
  for (const thread of listed) {
    const status = resolveSidebarRowStatus(thread);
    if (
      isAttentionStatus(status) &&
      (attention === null ||
        ATTENTION_ORDER.indexOf(status) < ATTENTION_ORDER.indexOf(attention.kind))
    ) {
      attention = {
        kind: status,
        label: resolve(BOT_ATTENTION_LABEL[status]),
        threadId: thread.id,
      };
    }
    if (status === "ready" && hasUnseenCompletion(thread)) unreadCount += 1;
    if (status === "working" || status === "preparing") workingCount += 1;
    latestActivityMs = Math.max(latestActivityMs, activityMs(thread));
  }
  return {
    health: resolveSidebarFolderDot(listed) ?? "idle",
    attention,
    unreadCount,
    workingCount,
    latestActivityMs,
  };
}

const BOT_STACK_LIMIT = 2;

export interface BotStackCard {
  readonly bot: Bot;
  readonly attention: BotAttention | null;
  /** Only the nearest card slides out, so two labels never overlap. */
  readonly slideOut: boolean;
}

/**
 * The cards behind the active bot: other bots that need the user come first, most urgent and
 * then most recent first; bots with unread replies follow, most recent first.
 */
export function deriveBotStack(input: {
  readonly bots: ReadonlyArray<Bot>;
  readonly activeKey: string | null;
  readonly activityByKey: ReadonlyMap<string, BotActivity>;
}): BotStackCard[] {
  const candidates = input.bots.flatMap((bot) => {
    if (bot.key === input.activeKey) return [];
    const activity = input.activityByKey.get(bot.key) ?? IDLE_BOT_ACTIVITY;
    return activity.attention !== null || activity.unreadCount > 0 ? [{ bot, activity }] : [];
  });
  const rank = (activity: BotActivity) =>
    activity.attention === null
      ? ATTENTION_ORDER.length
      : ATTENTION_ORDER.indexOf(activity.attention.kind);
  return candidates
    .toSorted(
      (left, right) =>
        rank(left.activity) - rank(right.activity) ||
        right.activity.latestActivityMs - left.activity.latestActivityMs,
    )
    .slice(0, BOT_STACK_LIMIT)
    .map(({ bot, activity }, index) => ({
      bot,
      attention: activity.attention,
      slideOut: index === 0 && activity.attention !== null,
    }));
}

export interface BotThreadNode<T> {
  readonly thread: T;
  readonly children: ReadonlyArray<BotThreadNode<T>>;
}

/**
 * The bot's conversations as a tree: forks and spin-offs nest under their parent when the parent
 * is listed too. The main thread leads; everything else is most recent first.
 */
export function buildBotThreadTree<T extends BotThread>(
  threads: ReadonlyArray<T>,
  mainThreadId: ThreadId | null = null,
): BotThreadNode<T>[] {
  const listed = threads.filter(isBotListedThread);
  const byId = new Map(listed.map((thread) => [thread.id, thread]));
  const listedParentOf = (thread: T): T | null => {
    const parentId = thread.lineage.parentThreadId;
    if (parentId === null || parentId === thread.id) return null;
    const parent = byId.get(parentId) ?? null;
    if (parent === null) return null;
    // A cycle would hide every thread in it, so a thread on one stays a root.
    const seen = new Set([thread.id]);
    let ancestor: T | null = parent;
    while (ancestor !== null) {
      if (seen.has(ancestor.id)) return null;
      seen.add(ancestor.id);
      const next: ThreadId | null = ancestor.lineage.parentThreadId;
      ancestor = next === null ? null : (byId.get(next) ?? null);
    }
    return parent;
  };
  const childrenByParent = new Map<ThreadId, T[]>();
  const roots: T[] = [];
  for (const thread of listed) {
    const parent = listedParentOf(thread);
    if (parent === null) {
      roots.push(thread);
      continue;
    }
    const siblings = childrenByParent.get(parent.id);
    if (siblings) siblings.push(thread);
    else childrenByParent.set(parent.id, [thread]);
  }
  const byRecency = (left: T, right: T) =>
    activityMs(right) - activityMs(left) || (left.id < right.id ? -1 : 1);
  const toNode = (thread: T): BotThreadNode<T> => ({
    thread,
    children: (childrenByParent.get(thread.id) ?? []).toSorted(byRecency).map(toNode),
  });
  return roots
    .toSorted(
      (left, right) =>
        Number(right.id === mainThreadId) - Number(left.id === mainThreadId) ||
        byRecency(left, right),
    )
    .map(toNode);
}

/** The conversation a bot opens on: its main thread, else its most recent one. */
export function resolveBotDefaultThreadId(
  bot: Bot,
  threads: ReadonlyArray<BotThread>,
): ThreadId | null {
  const mainThreadId = bot.settings.mainThreadId ?? null;
  let latest: BotThread | null = null;
  for (const thread of threads) {
    if (thread.projectId !== bot.project.id || thread.environmentId !== bot.project.environmentId) {
      continue;
    }
    if (!isBotListedThread(thread)) continue;
    if (thread.id === mainThreadId) return thread.id;
    if (latest === null || activityMs(thread) > activityMs(latest)) latest = thread;
  }
  return latest?.id ?? mainThreadId;
}

/** Names unique across routes: TanStack merges every route's search type in navigate reducers. */
export interface BotRouteSearch {
  readonly bot?: string;
  readonly thread?: string;
  readonly draftId?: string;
}

export function validateBotRouteSearch(raw: Record<string, unknown>): BotRouteSearch {
  const pick = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  const bot = pick(raw.bot);
  const thread = pick(raw.thread);
  const draftId = pick(raw.draftId);
  return {
    ...(bot === undefined ? {} : { bot }),
    ...(thread === undefined ? {} : { thread }),
    ...(draftId === undefined ? {} : { draftId }),
  };
}

export type BotGroupStatus =
  | { readonly kind: "attention"; readonly label: string }
  | { readonly kind: "working"; readonly label: string }
  | { readonly kind: "unread"; readonly label: string }
  | { readonly kind: "idle"; readonly label: string };

/** The short status a collapsed bot group shows beside its name. */
export function describeBotGroupStatus(
  activity: BotActivity,
  resolve: MessageResolver = m,
): BotGroupStatus {
  if (activity.attention !== null) {
    return { kind: "attention", label: activity.attention.label.toLowerCase() };
  }
  if (activity.workingCount > 0) {
    return {
      kind: "working",
      label:
        activity.workingCount === 1
          ? resolve(msg("working", { $context: "bot status" }))
          : resolve(msg("working · {count}", { count: activity.workingCount })),
    };
  }
  if (activity.unreadCount > 0) {
    return {
      kind: "unread",
      label: resolve(msg("{count} unread", { count: activity.unreadCount })),
    };
  }
  return { kind: "idle", label: resolve(msg("idle", { $context: "bot status" })) };
}
