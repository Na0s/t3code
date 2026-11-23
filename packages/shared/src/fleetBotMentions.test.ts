import { describe, expect, it } from "vite-plus/test";
import {
  collectFleetBotMentions,
  formatFleetBotMention,
  matchFleetBots,
} from "./fleetBotMentions.ts";

describe("Fleet bot mentions", () => {
  it("preserves distinct bot identities and ignores samples, paths and partial ids", () => {
    const text =
      "Ask bot:researcher, then (bot:backend-engineer). `bot:isaac` ```\nbot:isaac\n``` https://example/bot:isaac bot:isaac/other";
    expect(collectFleetBotMentions(text).map((mention) => mention.botId)).toEqual([
      "researcher",
      "backend-engineer",
    ]);
    for (const mention of collectFleetBotMentions(text))
      expect(text.slice(mention.start, mention.end)).toBe(mention.source);
    expect(collectFleetBotMentions(formatFleetBotMention("curriculum-design"))[0]?.botId).toBe(
      "curriculum-design",
    );
  });
  it("finds named recipients and the fleet without requiring a minimum query", () => {
    const bots = [
      { id: "curriculum-design", name: "Curriculum Design", icon: "🎨", color: "#00aabb" },
    ];
    expect(matchFleetBots(bots, "curriculum-design")).toEqual(bots);
    expect(matchFleetBots(bots, "grok")).toEqual(bots);
    expect(matchFleetBots(bots, "")).toEqual(bots);
    expect(matchFleetBots(bots, "backend")).toEqual([]);
  });
});
