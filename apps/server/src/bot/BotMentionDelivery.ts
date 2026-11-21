import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  composerContextPlainText,
  referencedBotMentions,
} from "@t3tools/shared/composerContextReferences";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";

export class BotMentionDeliveryError extends Schema.TaggedError<BotMentionDeliveryError>()(
  "BotMentionDeliveryError",
  {
    stage: Schema.Literals(["read-settings", "read-source", "read-bot", "send", "launch"]),
    projectId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Delivering a T3_BOT mention to ${this.projectId} failed at ${this.stage}.`;
  }
}

export interface BotMentionDeliveryInput {
  readonly sourceThreadId: ThreadId;
  readonly messageId: MessageId;
  readonly projectId: ProjectId;
}

export type BotMentionDeliveryResult =
  | {
      readonly status: "delivered";
      readonly threadId: ThreadId;
      readonly target: "main" | "recent" | "new";
    }
  | { readonly status: "already-delivered" }
  | {
      readonly status: "skipped";
      readonly reason: "not-a-bot" | "source-missing" | "other-environment" | "self";
    };

/** The title of the conversation a bot with no threads gets for its first mention. */
export const NEW_BOT_THREAD_TITLE = "Main";

/**
 * Runs `bot-mention.deliver` effects. Production provides it beside thread launch, which the
 * effect executor cannot depend on; elsewhere a mention is dropped.
 */
export class BotMentionDelivery extends Context.Reference<{
  readonly deliver: (
    input: BotMentionDeliveryInput,
  ) => Effect.Effect<BotMentionDeliveryResult, BotMentionDeliveryError>;
}>("t3/bot/BotMentionDelivery", {
  defaultValue: () => ({
    deliver: () => Effect.succeed({ status: "skipped", reason: "not-a-bot" } as const),
  }),
}) {}

/** The message a bot receives: where it was tagged, then what the user wrote. */
function botMentionMessageText(input: {
  readonly sourceTitle: string;
  readonly sourceLink: string;
  readonly text: string;
}): string {
  return `Tagged from ${input.sourceTitle} (${input.sourceLink}):\n\n${input.text}`;
}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  // Two mentions of a bot without threads must not each start a "Main".
  const lock = yield* Semaphore.make(1);

  const fail =
    (stage: BotMentionDeliveryError["stage"], projectId: ProjectId) => (cause: unknown) =>
      new BotMentionDeliveryError({ stage, projectId, cause });

  const selectTarget = Effect.fn("BotMentionDelivery.selectTarget")(function* (
    projectId: ProjectId,
    mainThreadId: ThreadId | null,
  ) {
    if (mainThreadId !== null) {
      const main = yield* threads.getThreadShell(mainThreadId);
      if (main !== null && main.projectId === projectId && main.archivedAt === null) {
        return { threadId: main.id, target: "main" as const };
      }
    }
    const [recent] = yield* threads.listProjectThreads({ projectId, includeSubagents: false });
    return recent === undefined ? null : { threadId: recent.id, target: "recent" as const };
  });

  // Runs only inside `deliver`, whose span covers it.
  const deliverUnlocked = Effect.fnUntraced(function* (input: BotMentionDeliveryInput) {
    const { projectId } = input;
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(fail("read-settings", projectId)),
    );
    const bot = current.bots[projectId];
    if (bot === undefined) return { status: "skipped", reason: "not-a-bot" } as const;

    const source = yield* threads
      .getThreadShell(input.sourceThreadId)
      .pipe(Effect.mapError(fail("read-source", projectId)));
    if (source === null) return { status: "skipped", reason: "source-missing" } as const;
    if (source.projectId === projectId) return { status: "skipped", reason: "self" } as const;
    const message = (yield* threads
      .getMessagesById(input.sourceThreadId, [input.messageId])
      .pipe(Effect.mapError(fail("read-source", projectId)))).get(input.messageId);
    if (message === undefined) return { status: "skipped", reason: "source-missing" } as const;
    const environmentId = yield* environment.getEnvironmentId;
    const records = message.context?.records ?? [];
    const tagged = referencedBotMentions(message.text, records).some(
      (record) => record.projectId === projectId && record.environmentId === environmentId,
    );
    if (!tagged) return { status: "skipped", reason: "other-environment" } as const;

    const project = yield* projects
      .getById(projectId)
      .pipe(Effect.mapError(fail("read-bot", projectId)));
    if (Option.isNone(project) || project.value.archivedAt !== null) {
      return { status: "skipped", reason: "not-a-bot" } as const;
    }

    const key = `${input.messageId}:${projectId}`;
    const sendCommandId = CommandId.make(`bot-mention:send:${key}`);
    const launchCommandId = CommandId.make(`bot-mention:launch:${key}`);
    const messageId = MessageId.make(`bot-mention:${key}`);
    const text = botMentionMessageText({
      sourceTitle: source.title,
      sourceLink: formatThreadLink({ environmentId, threadId: source.id }),
      text: composerContextPlainText(message.text, records),
    });
    const provenance = { createdBy: "user", creationSource: "server" } as const;

    const projectSettings = resolveProjectSettings(current, projectId, project.value).settings;
    const launch = launches
      .launch({
        commandId: launchCommandId,
        projectId,
        title: NEW_BOT_THREAD_TITLE,
        modelSelection: projectSettings.defaultModelSelection ?? source.modelSelection,
        runtimeMode: projectSettings.defaultRuntimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceStrategy: { type: "root" },
        initialMessage: { messageId, text, attachments: [] },
        ...provenance,
      })
      .pipe(
        Effect.map((launched) => ({
          status: "delivered" as const,
          threadId: launched.threadId,
          target: "new" as const,
        })),
        Effect.mapError(fail("launch", projectId)),
      );

    // Command receipts make a retry replay the first attempt. A retry must not pick a new
    // target either: a launched "Main" would otherwise also get a send.
    if (yield* threads.hasReceipt(launchCommandId)) return yield* launch;
    if (yield* threads.hasReceipt(sendCommandId)) return { status: "already-delivered" } as const;

    const target = yield* selectTarget(projectId, bot.mainThreadId ?? null).pipe(
      Effect.mapError(fail("read-bot", projectId)),
    );
    if (target === null) return yield* launch;
    yield* threads
      .sendToThread({
        projectId,
        commandId: sendCommandId,
        threadId: target.threadId,
        messageId,
        text,
        attachments: [],
        mode: "queue",
        ...provenance,
      })
      .pipe(Effect.mapError(fail("send", projectId)));
    return { status: "delivered", ...target } as const;
  });

  const deliver = Effect.fn("BotMentionDelivery.deliver")(function* (
    input: BotMentionDeliveryInput,
  ) {
    yield* Effect.annotateCurrentSpan({
      "bot_mention.project_id": input.projectId,
      "bot_mention.source_thread_id": input.sourceThreadId,
    });
    const result = yield* lock.withPermits(1)(deliverUnlocked(input));
    if (result.status === "skipped") {
      yield* Effect.logInfo("T3_BOT mention not delivered", {
        projectId: input.projectId,
        reason: result.reason,
      });
    }
    return result;
  });

  return { deliver };
});

export const layer = Layer.effect(BotMentionDelivery, make);
