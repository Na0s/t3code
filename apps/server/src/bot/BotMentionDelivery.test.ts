import {
  type BotSettings,
  CommandId,
  type ComposerContextRecord,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  botContextRecord,
  formatComposerContextReference,
  threadContextRecord,
} from "@t3tools/shared/composerContextReferences";
import { assert, it } from "@effect/vitest";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import * as BotMentionDelivery from "./BotMentionDelivery.ts";

const environmentId = EnvironmentId.make("environment:bot-mentions");
const sourceProjectId = ProjectId.make("project:source");
const botProjectId = ProjectId.make("project:atlas");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" };
const botModelSelection = { ...modelSelection, model: "gpt-5.1-codex-mini" };

const projectRecord = (id: ProjectId, title: string, defaultModel: typeof modelSelection) =>
  ({
    id,
    title,
    workspaceRoot: `/projects/${title.toLowerCase()}`,
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: defaultModel,
    defaultThreadEnvMode: null,
    scripts: [],
    pinnedAt: null,
    archivedAt: null,
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
    deletedAt: null,
  }) as const;
const projects = [
  projectRecord(sourceProjectId, "Source", modelSelection),
  projectRecord(botProjectId, "Atlas", botModelSelection),
];

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in bot mention tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

function makeLayer(bots: Record<string, BotSettings> = { [botProjectId]: {} }) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "bot-mentions" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerSettings = ServerSettings.layerTest({ bots });
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreads = ThreadManagement.layer.pipe(
    Layer.provide(Layer.mergeAll(layerOrchestrator, layerSettings, layerReceipts)),
  );
  const layerProjects = Layer.mock(ProjectService.ProjectService)({
    getById: (id) => Effect.succeed(Option.fromNullishOr(projects.find((p) => p.id === id))),
  });
  const layerLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerThreads,
        layerReceipts,
        layerOrchestrator,
        layerSettings,
        layerProjects,
        IdAllocator.layer,
        WorktreeSetupTracker.layer,
        ProviderRegistryMock.layer(),
        Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
        Layer.mock(CheckpointStore.CheckpointStore)({
          isGitRepository: () => Effect.succeed(false),
        }),
        Layer.mock(GitWorkflow.GitWorkflowService)({ currentBranch: () => Effect.succeed(null) }),
        Layer.mock(TextGeneration.TextGeneration)({}),
        Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
          runForThread: () => Effect.succeed({ status: "no-script" as const }),
        }),
        Layer.mock(TaskFolders.TaskFolders)({ plan: () => Effect.succeed(null) }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
          folderForThread: () => Effect.succeedNone,
        }),
      ),
    ),
  );
  const layerDelivery = BotMentionDelivery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerLaunch,
        layerThreads,
        layerSettings,
        layerProjects,
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
    ),
  );
  return Layer.mergeAll(
    layerDelivery,
    layerLaunch,
    layerThreads,
    EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  );
}

const atlas = botContextRecord({ environmentId, projectId: botProjectId }, "Atlas");

/** A source thread whose first message tags the given records; returns that message's id. */
const tagFromSourceThread = Effect.fn("test.tagFromSourceThread")(function* (
  records: ReadonlyArray<ComposerContextRecord> = [atlas],
  text = `${records.map((record) => formatComposerContextReference(record)).join(" ")} check the deploy`,
) {
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const threadId = ThreadId.make("thread:source");
  const messageId = MessageId.make("message:source");
  yield* launches.launch({
    commandId: CommandId.make("command:source"),
    threadId,
    projectId: sourceProjectId,
    title: "Fix login",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { messageId, text, attachments: [], context: { version: 1, records } },
    createdBy: "user",
    creationSource: "web",
  });
  return { threadId, messageId };
});

const launchBotThread = Effect.fn("test.launchBotThread")(function* (id: string) {
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  yield* TestClock.adjust("1 second");
  return (yield* launches.launch({
    commandId: CommandId.make(`command:${id}`),
    threadId: ThreadId.make(id),
    projectId: botProjectId,
    title: id,
    modelSelection: botModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    createdBy: "user",
    creationSource: "web",
  })).threadId;
});

const userMessages = Effect.fn("test.userMessages")(function* (threadId: ThreadId) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const { messages } = yield* threads.getThreadRecords(threadId, ["messages"]);
  return messages.filter((message) => message.role === "user").map((message) => message.text);
});

const expectedText = [
  "Tagged from Fix login (<t3-thread://v2/environment:bot-mentions/thread:source>):",
  "",
  "@Atlas check the deploy",
].join("\n");

it.effect("enqueues one delivery per tagged bot after the message commits", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const scout = botContextRecord(
      { environmentId, projectId: ProjectId.make("project:scout") },
      "Scout",
    );
    const text = [atlas, scout, atlas].map((bot) => formatComposerContextReference(bot)).join(" ");
    const { threadId, messageId } = yield* tagFromSourceThread([atlas, scout], text);
    // A retry of the accepted command replays its receipt.
    yield* tagFromSourceThread([atlas, scout], text);
    const deliveries = (yield* outbox.listByCommandId(CommandId.make("command:source")))
      .filter((effect) => effect.request.type === "bot-mention.deliver")
      .map((effect) => ({ threadId: effect.threadId, request: effect.request }));
    assert.deepStrictEqual(deliveries, [
      {
        threadId,
        request: { type: "bot-mention.deliver", messageId, projectId: botProjectId },
      },
      {
        threadId,
        request: { type: "bot-mention.deliver", messageId, projectId: scout.projectId },
      },
    ]);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("enqueues nothing for a message without bot tags", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const thread = threadContextRecord(
      { environmentId, threadId: ThreadId.make("thread:other") },
      "Other",
    );
    yield* tagFromSourceThread([thread]);
    // A record the text no longer references tags nobody.
    yield* tagFromSourceThread([atlas], "plain text");
    const types = (yield* outbox.listByCommandId(CommandId.make("command:source"))).map(
      (effect) => effect.request.type,
    );
    assert.notInclude(types, "bot-mention.deliver");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("delivers to the main thread once, however often the effect runs", () =>
  Effect.gen(function* () {
    const delivery = yield* BotMentionDelivery.BotMentionDelivery;
    const main = yield* launchBotThread("thread:atlas-main");
    const recent = yield* launchBotThread("thread:atlas-recent");
    const source = yield* tagFromSourceThread();
    const input = { sourceThreadId: source.threadId, messageId: source.messageId };

    const first = yield* delivery.deliver({ ...input, projectId: botProjectId });
    assert.deepStrictEqual(first, { status: "delivered", threadId: main, target: "main" });
    // A replay after a restart, or a retry after the send committed, sends nothing new.
    yield* delivery.deliver({ ...input, projectId: botProjectId });
    assert.deepStrictEqual(yield* userMessages(main), [expectedText]);
    assert.deepStrictEqual(yield* userMessages(recent), []);
  }).pipe(
    Effect.provide(
      makeLayer({ [botProjectId]: { mainThreadId: ThreadId.make("thread:atlas-main") } }),
    ),
  ),
);

it.effect("falls back to the most recent thread when the main thread is archived", () =>
  Effect.gen(function* () {
    const delivery = yield* BotMentionDelivery.BotMentionDelivery;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const older = yield* launchBotThread("thread:atlas-older");
    const main = yield* launchBotThread("thread:atlas-main");
    const recent = yield* launchBotThread("thread:atlas-recent");
    yield* threads.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("command:archive-main"),
      threadId: main,
    });
    const source = yield* tagFromSourceThread();

    const result = yield* delivery.deliver({
      sourceThreadId: source.threadId,
      messageId: source.messageId,
      projectId: botProjectId,
    });
    assert.deepStrictEqual(result, { status: "delivered", threadId: recent, target: "recent" });
    assert.deepStrictEqual(yield* userMessages(recent), [expectedText]);
    assert.deepStrictEqual(yield* userMessages(older), []);
  }).pipe(
    Effect.provide(
      makeLayer({ [botProjectId]: { mainThreadId: ThreadId.make("thread:atlas-main") } }),
    ),
  ),
);

it.effect("starts a Main thread on the bot's default model when it has none, once", () =>
  Effect.gen(function* () {
    const delivery = yield* BotMentionDelivery.BotMentionDelivery;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const source = yield* tagFromSourceThread();
    const input = {
      sourceThreadId: source.threadId,
      messageId: source.messageId,
      projectId: botProjectId,
    };

    const first = yield* delivery.deliver(input);
    assert.equal(first.status, "delivered");
    if (first.status !== "delivered") return;
    assert.equal(first.target, "new");
    // The Main thread now exists, so a retry that picked a target again would also send to it.
    const retry = yield* delivery.deliver(input);
    assert.deepStrictEqual(retry, first);

    const botThreads = yield* threads.listProjectThreads({
      projectId: botProjectId,
      includeSubagents: false,
    });
    assert.deepStrictEqual(
      botThreads.map((thread) => thread.title),
      [BotMentionDelivery.NEW_BOT_THREAD_TITLE],
    );
    const shell = yield* threads.getThreadShell(first.threadId);
    assert.deepStrictEqual(shell?.modelSelection, botModelSelection);
    assert.deepStrictEqual(yield* userMessages(first.threadId), [expectedText]);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("delivers nothing to a project that is not a bot, or a bot on another environment", () =>
  Effect.gen(function* () {
    const delivery = yield* BotMentionDelivery.BotMentionDelivery;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const elsewhere = botContextRecord(
      { environmentId: EnvironmentId.make("environment:other"), projectId: botProjectId },
      "Atlas",
    );
    const source = yield* tagFromSourceThread([elsewhere]);
    const input = { sourceThreadId: source.threadId, messageId: source.messageId };

    assert.deepStrictEqual(yield* delivery.deliver({ ...input, projectId: botProjectId }), {
      status: "skipped",
      reason: "other-environment",
    });
    assert.deepStrictEqual(yield* delivery.deliver({ ...input, projectId: sourceProjectId }), {
      status: "skipped",
      reason: "not-a-bot",
    });
    assert.deepStrictEqual(
      yield* threads.listProjectThreads({ projectId: botProjectId, includeSubagents: false }),
      [],
    );
  }).pipe(Effect.provide(makeLayer())),
);
