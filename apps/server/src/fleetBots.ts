// @effect-diagnostics-next-line nodeBuiltinImport:off -- Routing request IDs are a synchronous deterministic digest, independent of runtime crypto services.
import * as NodeCrypto from "node:crypto";
import { FleetBot, type ServerSettings, type ThreadId } from "@t3tools/contracts";
import { collectFleetBotMentions } from "@t3tools/shared/fleetBotMentions";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Settings from "./serverSettings.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as ProcessRunner from "./processRunner.ts";

export class FleetBotError extends Schema.TaggedError<FleetBotError>()("FleetBotError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const isFleetBotError = Schema.is(FleetBotError);

const catalogSchema = Schema.Struct({
  bots: Schema.Array(FleetBot).check(Schema.isMaxLength(100)),
});

export const discoverFleetBots = Effect.fn("FleetBots.discover")(function* (
  command: ServerSettings["fleetGatewayCommand"],
) {
  if (command.length === 0) return [];
  const runner = yield* Effect.serviceOption(ProcessRunner.ProcessRunner);
  if (Option.isNone(runner))
    return yield* new FleetBotError({
      detail: "Fleet gateway process execution is unavailable on this environment.",
    });
  const result = yield* runner.value
    .run({
      command: command[0]!,
      args: [...command.slice(1), "bots", "list", "--json"],
      timeout: "10 seconds",
      maxOutputBytes: 64 * 1024,
    })
    .pipe(
      Effect.mapError(
        () =>
          new FleetBotError({
            detail:
              "Fleet gateway bot discovery failed. Check the configured gateway command on this machine.",
          }),
      ),
    );
  if (result.code !== 0 || result.stdoutInvalidUtf8 || result.stdoutTruncated) {
    return yield* new FleetBotError({
      detail:
        "Fleet gateway bot discovery failed. Check the configured gateway command on this machine.",
    });
  }
  const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(catalogSchema))(
    result.stdout,
  ).pipe(
    Effect.mapError(
      () => new FleetBotError({ detail: "Fleet gateway returned an invalid bot catalog." }),
    ),
  );
  if (new Set(parsed.bots.map((bot) => bot.id)).size !== parsed.bots.length) {
    return yield* new FleetBotError({ detail: "Fleet gateway returned duplicate bot identities." });
  }
  return parsed.bots;
});

export function fleetBotInstructions(input: {
  readonly text: string;
  readonly mentionText?: string;
  readonly bots: ReadonlyArray<FleetBot>;
  readonly command: ReadonlyArray<string>;
  readonly environmentId: string;
  readonly threadId: ThreadId;
  readonly messageId: string;
}): string {
  const ids = [
    ...new Set(
      collectFleetBotMentions(input.mentionText ?? input.text).map((mention) => mention.botId),
    ),
  ];
  if (ids.length === 0) return input.text;
  if (input.command.length === 0)
    throw new FleetBotError({
      detail: "Configure Fleet gateway on this environment before mentioning a bot.",
    });
  const selected = ids.map((id) => {
    const bot = input.bots.find((candidate) => candidate.id === id);
    if (!bot)
      throw new FleetBotError({
        detail: `Fleet bot '${id}' is unavailable. Choose a bot from the current @ picker.`,
      });
    return bot;
  });
  const requests = selected.map((bot) => ({
    botId: bot.id,
    environmentId: input.environmentId,
    threadId: input.threadId,
    requestId: `mention:${NodeCrypto.createHash("sha256")
      .update(JSON.stringify([input.environmentId, input.threadId, input.messageId, bot.id]))
      .digest("hex")}`,
    message: "<write the message requested by the user>",
  }));
  return `${input.text}\n\n<fleet_bot_mentions>\nThe user selected these Fleet gateway recipients: ${selected.map((bot) => JSON.stringify({ id: bot.id, name: bot.name })).join(", ")}. Contact the selected bots when carrying out the user's request.\nRun the following executable and argv on this environment, without a shell: ${JSON.stringify([...input.command, "bots", "send", "--json"])}. Supply one JSON object on stdin per invocation, replacing only message with the intended communication:\n${requests.map((request) => JSON.stringify(request)).join("\n")}\nKeep the exact botId, environmentId, threadId and requestId. Reuse the requestId for a retry of the same message; never create a new ID to bypass an uncertain or failed delivery. Report gateway acceptance separately from bot acknowledgment. A mention authorizes the requested communication, not thread ownership transfer, interruption, or background notification subscriptions. If the gateway is unavailable, report it rather than selecting another recipient.\n</fleet_bot_mentions>`;
}

export const makeFleetBotProjector = Effect.gen(function* () {
  const settings = yield* Effect.serviceOption(Settings.ServerSettingsService);
  const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  const runner = yield* Effect.serviceOption(ProcessRunner.ProcessRunner);
  return Effect.fn("FleetBots.projectMentions")(function* (input: {
    readonly text: string;
    readonly mentionText?: string;
    readonly threadId: ThreadId;
    readonly messageId: string;
  }) {
    if (collectFleetBotMentions(input.mentionText ?? input.text).length === 0) return input.text;
    if (Option.isNone(settings) || Option.isNone(environment) || Option.isNone(runner)) {
      return yield* new FleetBotError({
        detail: "Fleet bot routing is unavailable on this environment.",
      });
    }
    const command = (yield* settings.value.getSettings.pipe(
      Effect.mapError(
        () => new FleetBotError({ detail: "Unable to read Fleet gateway settings." }),
      ),
    )).fleetGatewayCommand;
    const environmentId = yield* environment.value.getEnvironmentId;
    const bots = yield* discoverFleetBots(command).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner.value),
    );
    return yield* Effect.try({
      try: () => fleetBotInstructions({ ...input, command, environmentId, bots }),
      catch: (error) =>
        isFleetBotError(error)
          ? error
          : new FleetBotError({ detail: "Unable to prepare Fleet bot routing." }),
    });
  });
});
