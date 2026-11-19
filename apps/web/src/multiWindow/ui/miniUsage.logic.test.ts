import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CLAUDE,
  CLAUDE_UNREADABLE,
  CODEX,
  FIXTURE_NOW,
  presentations,
  provider,
  usageWindow,
} from "./mini.fixtures";
import { deriveMiniUsage, formatCheckedAgo, withoutHiddenProviders } from "./miniUsage.logic";

const derive = (...args: Parameters<typeof presentations>) =>
  deriveMiniUsage(presentations(...args), FIXTURE_NOW);

describe("deriveMiniUsage", () => {
  it("is loading until an environment reports, then empty when nothing has limits", () => {
    expect(deriveMiniUsage(new Map(), FIXTURE_NOW)).toEqual({ status: "loading" });
    expect(derive(null, "connecting")).toEqual({ status: "loading" });
    expect(derive([])).toEqual({ status: "empty" });
    expect(derive([provider("codex", undefined)])).toEqual({ status: "empty" });
  });

  it("summarizes each provider's windows with what is left, the pace and the reset", () => {
    expect(derive([CLAUDE, CODEX])).toEqual({
      status: "ready",
      links: [],
      notices: [],
      checkedAt: FIXTURE_NOW - 4 * 60_000,
      providers: [
        {
          driver: "claudeAgent",
          detail: "Max",
          accentColor: undefined,
          windows: [
            {
              key: "session:five_hour",
              label: "Session",
              remainingPercent: 62,
              tone: "normal",
              pace: "under",
              evenPacePercent: 45,
              reset: "resets in 2h 15m",
            },
            {
              key: "weekly:seven_day",
              label: "Weekly",
              remainingPercent: 41,
              tone: "normal",
              pace: "on",
              evenPacePercent: 45,
              reset: "resets in 3d 4h",
            },
          ],
        },
        {
          driver: "codex",
          detail: "ChatGPT Pro 100",
          accentColor: undefined,
          windows: [
            expect.objectContaining({ remainingPercent: 6, tone: "low", pace: "ahead" }),
            expect.objectContaining({ remainingPercent: 78, tone: "normal", pace: "under" }),
          ],
        },
      ],
    });
  });

  it("marks a spent window and pools several accounts of one provider", () => {
    const usage = derive([
      provider(
        "claudeAgent",
        { windows: [usageWindow("five_hour", "session", "Session", 100, 1, 5)] },
        { plan: "Max", email: "ada@example.com", name: "Work" },
      ),
      provider(
        "claudeAgent",
        { windows: [usageWindow("five_hour", "session", "Session", 20, 3, 5)] },
        { plan: "Max", email: "grace@example.com", name: "Personal" },
      ),
      provider("codex", { windows: [usageWindow("primary", "session", "Session", 100, 1, 5)] }),
    ]);
    expect(usage).toMatchObject({
      providers: [
        {
          detail: "2 accounts",
          windows: [{ remainingPercent: 40, evenPacePercent: null, reset: "+50% in 1h 0m" }],
        },
        { detail: null, windows: [{ remainingPercent: 0, tone: "out", reset: "resets in 1h 0m" }] },
      ],
    });
  });

  it("reports unreadable, external and disconnected usage instead of rows", () => {
    expect(
      derive([
        CLAUDE_UNREADABLE,
        provider("codex", {
          unavailable: { reason: "unsupported" },
          externalUsage: { label: "ChatGPT usage", url: "https://chatgpt.com/#settings/Usage" },
        }),
      ]),
    ).toMatchObject({
      status: "ready",
      providers: [],
      notices: ["Claude: Could not read limits. Sign in again."],
      links: [{ label: "ChatGPT usage" }],
      checkedAt: null,
    });
    expect(derive(null, "offline", "Studio")).toMatchObject({
      providers: [],
      notices: ["Studio: Not connected."],
    });
  });
});

describe("withoutHiddenProviders", () => {
  it("drops the drivers hidden on the Usage page", () => {
    const visible = withoutHiddenProviders(
      presentations([CLAUDE, CODEX]),
      new Set([ProviderDriverKind.make("codex")]),
    );
    expect(deriveMiniUsage(visible, FIXTURE_NOW)).toMatchObject({
      providers: [{ driver: "claudeAgent" }],
    });
  });
});

describe("formatCheckedAgo", () => {
  it("rounds a fresh reading to now and ages an older one", () => {
    expect(formatCheckedAgo(FIXTURE_NOW - 20_000, FIXTURE_NOW)).toBe("Updated just now");
    expect(formatCheckedAgo(FIXTURE_NOW - 65 * 60_000, FIXTURE_NOW)).toBe("Updated 1h 5m ago");
  });
});
