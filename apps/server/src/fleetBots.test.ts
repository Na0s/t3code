import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Settings from "./serverSettings.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as ProcessRunner from "./processRunner.ts";
import { discoverFleetBots, fleetBotInstructions, makeFleetBotProjector } from "./fleetBots.ts";

const bots = [{ id: "design", name: "Design", icon: "◕", color: "#10b981" }];
const threadId = ThreadId.make("thread-1");
const command = [
  process.execPath,
  "-e",
  `process.stdout.write(${JSON.stringify(JSON.stringify({ bots }))})`,
];
const identity = Layer.mock(ServerEnvironment.ServerEnvironment)({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
});
const dependencies = Layer.mergeAll(
  Settings.layerTest({ fleetGatewayCommand: command }),
  identity,
  ProcessRunner.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

describe("Fleet bot routing", () => {
  it.effect(
    "discovers a real process catalog and supplies exact selected identity and retry key",
    () =>
      Effect.gen(function* () {
        const projected = yield* Effect.gen(function* () {
          const project = yield* makeFleetBotProjector;
          return yield* project({
            text: "Ask bot:design to review the flow",
            threadId,
            messageId: "message-1",
          });
        }).pipe(Effect.provide(dependencies));
        expect(projected).toMatch(
          /"botId":"design","environmentId":"environment-1","threadId":"thread-1","requestId":"mention:[0-9a-f]{64}"/u,
        );
        expect(projected).toContain(JSON.stringify([...command, "bots", "send", "--json"]));
        expect(projected).toContain("not thread ownership transfer");
      }),
  );

  it.effect("keeps ordinary work independent and refuses unavailable or stale mentions", () =>
    Effect.gen(function* () {
      const project = yield* makeFleetBotProjector;
      expect(
        yield* project({
          text: "Review the flow\n<terminal>bot:design</terminal>",
          mentionText: "Review the flow",
          threadId,
          messageId: "m",
        }),
      ).toBe("Review the flow\n<terminal>bot:design</terminal>");
      expect(yield* project({ text: "Review the flow", threadId, messageId: "m" })).toBe(
        "Review the flow",
      );
      expect(
        (yield* project({ text: "Ask bot:design", threadId, messageId: "m" }).pipe(Effect.flip))
          .detail,
      ).toContain("Fleet bot routing is unavailable");
      expect(() =>
        fleetBotInstructions({
          text: "Ask bot:missing",
          bots,
          command,
          environmentId: "env",
          threadId,
          messageId: "m",
        }),
      ).toThrow("unavailable");
      expect(() =>
        fleetBotInstructions({
          text: "Ask bot:design",
          bots,
          command: [],
          environmentId: "env",
          threadId,
          messageId: "m",
        }),
      ).toThrow("Configure Fleet gateway");
    }),
  );

  it.effect.each([
    { bots: [bots[0], bots[0]] },
    { bots: [{ ...bots[0], color: "url(https://example.test)" }] },
    { bots: [{ ...bots[0], id: "design; touch unsafe" }] },
  ])("rejects malformed discovery without exposing process output", (catalog) =>
    Effect.gen(function* () {
      const result = yield* discoverFleetBots([
        process.execPath,
        "-e",
        `process.stdout.write(${JSON.stringify(JSON.stringify(catalog))})`,
      ]).pipe(Effect.provide(dependencies), Effect.flip);
      expect(result.message).toMatch(/Fleet gateway returned/);
    }),
  );
});
