import {
  isListedThreadLineage,
  type BotSettings,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@t3tools/shared/paletteSearch";

import type { EnvironmentProject, EnvironmentThreadShell } from "./state/models.ts";
import { threadSearchSubject, type ThreadSearchShell } from "./state/threadSearch.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

const COMPOSER_THREAD_RESULT_LIMIT = 5;

export type ComposerThreadCandidate = ThreadSearchShell &
  Pick<EnvironmentThreadShell, "archivedAt" | "lineage">;

export interface ComposerThreadItem {
  readonly id: string;
  readonly type: "thread";
  readonly thread: ScopedThreadRef;
  readonly label: string;
  readonly description: string;
}

/**
 * Threads to reference from the composer, matched and ranked like the command
 * palette, without subagent threads or other threads' side chats. The agent reads threads
 * on its own server and on the machines it links to, so candidates stay within those, and a
 * linked machine's threads say which machine they are on.
 */
export function matchComposerThreadItems(
  input: {
    shells: ReadonlyArray<ComposerThreadCandidate>;
    environmentId: EnvironmentId;
    /** The machines the composer's environment links to, by name. */
    linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
    excludeThreadId: ThreadId | null;
    query: string;
    /** Recency is measured against this time. */
    now: number;
  },
  resolve: MFunctionType = mFallback,
): ComposerThreadItem[] {
  const query = foldSearchQuery(input.query);
  if (query.length === 0) return [];
  // Closing an unused side chat deletes it, so only one with a message is offered.
  const isOwnSideChat = (shell: ComposerThreadCandidate) =>
    shell.lineage.sideChat === true &&
    shell.environmentId === input.environmentId &&
    shell.lineage.parentThreadId === input.excludeThreadId &&
    shell.latestUserMessageAt !== null;
  const candidates = input.shells.filter(
    (shell) =>
      (shell.environmentId === input.environmentId ||
        input.linkedEnvironments.has(shell.environmentId)) &&
      shell.id !== input.excludeThreadId &&
      shell.archivedAt === null &&
      (isListedThreadLineage(shell.lineage) || isOwnSideChat(shell)),
  );
  return rankSearchItems(candidates, (shell, options) =>
    scoreThreadSearch(query, threadSearchSubject(shell, null), input.now, {
      ...options,
      picks: false,
    }),
  )
    .slice(0, COMPOSER_THREAD_RESULT_LIMIT)
    .map(({ item: shell }) => {
      const machine =
        shell.environmentId === input.environmentId
          ? undefined
          : input.linkedEnvironments.get(shell.environmentId);
      return {
        id: `thread:${shell.environmentId}:${shell.id}`,
        type: "thread",
        thread: { environmentId: shell.environmentId, threadId: shell.id },
        label: shell.title,
        description: isOwnSideChat(shell)
          ? resolve(msg("Side chat"))
          : machine === undefined
            ? resolve(msg("Thread", { $context: "noun, search result type" }))
            : resolve(msg("Thread on {machine}", { machine })),
      };
    });
}

export interface ComposerEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
}

export interface ComposerEnvironmentItem {
  readonly id: string;
  readonly type: "environment";
  readonly environmentId: EnvironmentId;
  readonly machine: EnvironmentMachineKind;
  readonly label: string;
  readonly description: string;
}

/**
 * The machines the `@` picker offers, so the agent can link or work there: the client's paired
 * machines and those the composer's environment links to. The composer's own environment is
 * left out. Like threads, they need a query: bare `@` stays a file picker.
 */
export function matchComposerEnvironmentItems(
  input: {
    environments: ReadonlyArray<ComposerEnvironmentCandidate>;
    /** The machines the composer's environment links to, by name. */
    linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
    environmentId: EnvironmentId;
    query: string;
  },
  resolve: MFunctionType = mFallback,
): ComposerEnvironmentItem[] {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) return [];
  const paired = new Set(input.environments.map((environment) => environment.environmentId));
  const linkedOnly = Array.from(input.linkedEnvironments, ([environmentId, label]) => ({
    environmentId,
    label,
    machine: "server" as const,
  })).filter((environment) => !paired.has(environment.environmentId));
  return [...input.environments, ...linkedOnly]
    .filter(
      (environment) =>
        environment.environmentId !== input.environmentId &&
        environment.label.toLowerCase().includes(query),
    )
    .map((environment) => ({
      id: `environment:${environment.environmentId}`,
      type: "environment",
      environmentId: environment.environmentId,
      machine: environment.machine,
      label: environment.label,
      description: resolve(msg("Machine", { $context: "noun, search result type" })),
    }));
}

export interface ComposerBotItem {
  readonly id: string;
  readonly type: "bot";
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly label: string;
  readonly description: string;
}

/**
 * The composer environment's T3_BOTs the `@` picker offers. Tagging one has its server deliver
 * the message to the bot, so bots on other machines stay out. Like threads, they need a query;
 * "bot" lists them all.
 */
export function matchComposerBotItems(input: {
  projects: ReadonlyArray<EnvironmentProject>;
  bots: Readonly<Record<string, BotSettings | undefined>> | null | undefined;
  environmentId: EnvironmentId;
  query: string;
}): ComposerBotItem[] {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0 || !input.bots) return [];
  const bots = input.bots;
  return input.projects
    .flatMap((project) => {
      const settings = bots[project.id];
      return project.environmentId === input.environmentId &&
        project.archivedAt == null &&
        settings !== undefined
        ? [{ project, settings }]
        : [];
    })
    .filter(({ project, settings }) =>
      `${project.title} ${settings.role ?? ""} bot t3_bot`.toLowerCase().includes(query),
    )
    .sort(
      (left, right) =>
        (left.settings.order ?? Number.POSITIVE_INFINITY) -
          (right.settings.order ?? Number.POSITIVE_INFINITY) ||
        left.project.title.localeCompare(right.project.title),
    )
    .map(({ project, settings }) => ({
      id: `bot:${project.environmentId}:${project.id}`,
      type: "bot",
      environmentId: project.environmentId,
      projectId: project.id,
      label: project.title,
      // oxlint-disable-next-line t3code/no-untranslated-copy -- T3_BOT is the feature's name
      description: settings.role?.trim() || "T3_BOT",
    }));
}
