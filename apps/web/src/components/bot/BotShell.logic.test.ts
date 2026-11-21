import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type BotSettings,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import {
  buildBotThreadTree,
  deriveBotStack,
  describeBotGroupStatus,
  listBots,
  nextBotOrder,
  resolveBotActivity,
  resolveBotDefaultThreadId,
  validateBotRouteSearch,
  type Bot,
  type BotActivity,
  type BotThread,
  type BotThreadNode,
} from "./BotShell.logic";

const environmentId = EnvironmentId.make("environment-test");

function project(
  id: string,
  title: string,
  overrides: Partial<EnvironmentProject> = {},
  isBot = true,
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title,
    workspaceRoot: `/bots/${id}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...(isBot ? { isBot: true as const } : {}),
    ...overrides,
  };
}

function bot(id: string, settings: BotSettings = {}): Bot {
  return { key: `${environmentId}:${id}`, project: project(id, id), settings };
}

function run(status: OrchestrationV2RunStatus, completedAt: string | null) {
  return {
    runId: RunId.make(`run-${completedAt ?? "open"}`),
    status,
    requestedAt: "2026-11-20T09:00:00.000Z",
    startedAt: "2026-11-20T09:00:01.000Z",
    completedAt,
    assistantMessageId: null,
  };
}

const failedRuntime = {
  status: "failed" as const,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: null,
  lastError: "boom",
  updatedAt: "2026-11-20T13:00:00.000Z",
};

function thread(id: string, overrides: Parameters<typeof makeThreadFixture>[0] = {}): BotThread {
  return makeThreadFixture({
    id: ThreadId.make(id),
    projectId: ProjectId.make("atlas"),
    lastVisitedAt: "2026-11-20T12:00:00.000Z",
    ...overrides,
  });
}

function fork(id: string, parent: string, overrides: Parameters<typeof makeThreadFixture>[0] = {}) {
  return thread(id, {
    lineage: {
      rootThreadId: ThreadId.make(parent),
      parentThreadId: ThreadId.make(parent),
      relationshipToParent: "fork",
    },
    ...overrides,
  });
}

function activity(overrides: Partial<BotActivity>): BotActivity {
  return {
    health: "idle",
    attention: null,
    unreadCount: 0,
    workingCount: 0,
    latestActivityMs: 0,
    ...overrides,
  };
}

describe("listBots", () => {
  it("keeps configured bot projects in order, then by name", () => {
    const bots = listBots(
      [
        project("zed", "Zed"),
        project("atlas", "Atlas"),
        project("warden", "Warden"),
        project("plain", "Plain", {}, false),
        project("gone", "Gone", { archivedAt: "2026-11-02T00:00:00.000Z" }),
        project("unset", "Unset"),
      ],
      new Map([
        [
          environmentId,
          {
            [ProjectId.make("zed")]: {},
            [ProjectId.make("atlas")]: { order: 1 },
            [ProjectId.make("warden")]: { order: 0 },
            [ProjectId.make("plain")]: { order: 2 },
            [ProjectId.make("gone")]: { order: 3 },
          },
        ],
      ]),
    );
    expect(bots.map((entry) => entry.project.title)).toEqual(["Warden", "Atlas", "Zed"]);
  });

  it("places a new bot after every existing one", () => {
    expect(nextBotOrder([])).toBe(0);
    expect(nextBotOrder([bot("a", { order: 4 }), bot("b")])).toBe(5);
    expect(nextBotOrder([bot("a"), bot("b")])).toBe(2);
  });
});

describe("resolveBotActivity", () => {
  it("reports the most urgent thread waiting on the user", () => {
    const result = resolveBotActivity([
      thread("failed", {
        latestRun: run("failed", "2026-11-20T13:00:00.000Z"),
        runtime: failedRuntime,
      }),
      thread("input", { hasPendingUserInput: true }),
      thread("approval", { hasPendingApprovals: true, archivedAt: "2026-11-20T00:00:00.000Z" }),
    ]);
    expect(result.attention).toEqual({
      kind: "input",
      label: "Needs input",
      threadId: ThreadId.make("input"),
    });
    expect(result.health).toBe("attention");
  });

  it("counts a failure the user already opened as settled, like the sidebar", () => {
    const seen = resolveBotActivity([
      thread("failed", {
        latestRun: run("failed", "2026-11-20T11:00:00.000Z"),
        runtime: failedRuntime,
      }),
    ]);
    expect(seen.attention).toBeNull();
    const unseen = resolveBotActivity([
      thread("failed", {
        latestRun: run("failed", "2026-11-20T13:00:00.000Z"),
        runtime: failedRuntime,
      }),
    ]);
    expect(unseen.attention?.label).toBe("Failed");
    expect(unseen.health).toBe("failed");
  });

  it("counts unread completions and ignores side chats and subagents", () => {
    const completed = run("completed", "2026-11-20T13:00:00.000Z");
    const result = resolveBotActivity([
      thread("done", { latestRun: completed, runtime: null }),
      thread("side", {
        latestRun: completed,
        runtime: null,
        lineage: {
          rootThreadId: ThreadId.make("done"),
          parentThreadId: ThreadId.make("done"),
          relationshipToParent: "fork",
          sideChat: true,
        },
      }),
      thread("sub", {
        hasPendingUserInput: true,
        lineage: {
          rootThreadId: ThreadId.make("done"),
          parentThreadId: ThreadId.make("done"),
          relationshipToParent: "subagent",
        },
      }),
    ]);
    expect(result).toMatchObject({ health: "unread", attention: null, unreadCount: 1 });
  });
});

describe("deriveBotStack", () => {
  const bots = ["atlas", "warden", "scout", "relay", "quill"].map((id) => bot(id));
  const key = (id: string) => `${environmentId}:${id}`;

  it("stacks other bots that need the user ahead of unread ones, at most two", () => {
    const stack = deriveBotStack({
      bots,
      activeKey: key("atlas"),
      activityByKey: new Map([
        [key("atlas"), activity({ unreadCount: 3, latestActivityMs: 99 })],
        [key("scout"), activity({ unreadCount: 1, latestActivityMs: 50 })],
        [key("relay"), activity({ unreadCount: 2, latestActivityMs: 70 })],
        [
          key("warden"),
          activity({
            attention: { kind: "input", label: "Needs input", threadId: ThreadId.make("w") },
            latestActivityMs: 10,
          }),
        ],
        [key("quill"), activity({ workingCount: 1, latestActivityMs: 100 })],
      ]),
    });
    expect(stack.map((card) => [card.bot.project.id, card.slideOut])).toEqual([
      ["warden", true],
      ["relay", false],
    ]);
  });

  it("slides out only the nearest card when several bots need the user", () => {
    const attention = (kind: "approval" | "failed") => ({
      kind,
      label: kind,
      threadId: ThreadId.make(kind),
    });
    const stack = deriveBotStack({
      bots,
      activeKey: key("atlas"),
      activityByKey: new Map([
        [key("scout"), activity({ attention: attention("failed"), latestActivityMs: 90 })],
        [key("relay"), activity({ attention: attention("approval"), latestActivityMs: 10 })],
      ]),
    });
    expect(stack.map((card) => [card.bot.project.id, card.slideOut])).toEqual([
      ["relay", true],
      ["scout", false],
    ]);
  });

  it("is empty when no other bot has news", () => {
    expect(
      deriveBotStack({
        bots,
        activeKey: key("atlas"),
        activityByKey: new Map([[key("atlas"), activity({ unreadCount: 1 })]]),
      }),
    ).toEqual([]);
  });
});

describe("buildBotThreadTree", () => {
  const at = (minute: number) => ({
    latestUserMessageAt: `2026-11-20T10:${String(minute).padStart(2, "0")}:00.000Z`,
  });

  it("nests forks under listed parents and leads with the main thread", () => {
    const tree = buildBotThreadTree(
      [
        thread("inbox", at(50)),
        thread("main", at(10)),
        fork("follow-up", "main", at(30)),
        fork("deeper", "follow-up", at(40)),
        fork("orphan", "missing", at(20)),
        fork("late", "main", at(45)),
        thread("old", { ...at(5), archivedAt: "2026-11-20T00:00:00.000Z" }),
      ],
      ThreadId.make("main"),
    );
    const shape = (nodes: ReadonlyArray<BotThreadNode<BotThread>>): unknown =>
      nodes.map((node) =>
        node.children.length === 0 ? node.thread.id : [node.thread.id, shape(node.children)],
      );
    expect(shape(tree)).toEqual([["main", ["late", ["follow-up", ["deeper"]]]], "inbox", "orphan"]);
  });

  it("keeps threads on a lineage cycle as roots", () => {
    const tree = buildBotThreadTree([fork("a", "b"), fork("b", "a")]);
    expect(tree.map((node) => node.thread.id).toSorted()).toEqual(["a", "b"]);
  });
});

describe("resolveBotDefaultThreadId", () => {
  const atlas = bot("atlas", { mainThreadId: ThreadId.make("main") });

  it("opens the main thread when it is listed", () => {
    expect(
      resolveBotDefaultThreadId(atlas, [
        thread("main", { latestUserMessageAt: "2026-11-20T09:00:00.000Z" }),
        thread("newer", { latestUserMessageAt: "2026-11-20T10:00:00.000Z" }),
      ]),
    ).toBe("main");
  });

  it("falls back to the bot's most recent listed thread", () => {
    expect(
      resolveBotDefaultThreadId(atlas, [
        thread("older", { latestUserMessageAt: "2026-11-20T09:00:00.000Z" }),
        thread("newer", { latestUserMessageAt: "2026-11-20T10:00:00.000Z" }),
        thread("other-bot", {
          projectId: ProjectId.make("warden"),
          latestUserMessageAt: "2026-11-20T11:00:00.000Z",
        }),
        thread("main", {
          archivedAt: "2026-11-20T00:00:00.000Z",
          latestUserMessageAt: "2026-11-20T12:00:00.000Z",
        }),
      ]),
    ).toBe("newer");
  });
});

describe("validateBotRouteSearch", () => {
  it("keeps non-empty strings only", () => {
    expect(validateBotRouteSearch({ bot: " env:atlas ", thread: "", draftId: 4 })).toEqual({
      bot: "env:atlas",
    });
  });
});

describe("describeBotGroupStatus", () => {
  it("prefers attention, then work, then unread", () => {
    expect(
      describeBotGroupStatus(
        activity({
          attention: { kind: "input", label: "Needs input", threadId: ThreadId.make("t") },
          workingCount: 2,
        }),
      ),
    ).toEqual({ kind: "attention", label: "needs input" });
    expect(describeBotGroupStatus(activity({ workingCount: 2, unreadCount: 1 }))).toEqual({
      kind: "working",
      label: "working · 2",
    });
    expect(describeBotGroupStatus(activity({}))).toEqual({ kind: "idle", label: "idle" });
  });
});
