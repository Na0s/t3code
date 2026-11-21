import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveBotSectionSpans,
  formatBotSectionLabel,
  parseBotSectionMarkers,
  type BotSectionMessageMarkers,
} from "./botSections.ts";

describe("parseBotSectionMarkers", () => {
  it.each<[string, BotSectionMessageMarkers | null]>([
    ["No markers here.", null],
    ["Mentions t3bot:section outside a comment.", null],
    [
      '<!-- t3bot:section kind="status-check" -->\nAll green.',
      { start: { kind: "status-check", label: null }, end: false },
    ],
    [
      'Intro <!--t3bot:section label=" Morning sweep " kind="heartbeat"--> text',
      { start: { kind: "heartbeat", label: "Morning sweep" }, end: false },
    ],
    ["Done.\n\n<!-- t3bot:section-end -->", { start: null, end: true }],
    [
      '<!-- t3bot:section kind="webhook" -->\nHandled.\n<!-- t3bot:section-end -->',
      { start: { kind: "webhook", label: null }, end: true },
    ],
    // An end before a start only closes the previous section.
    [
      '<!-- t3bot:section-end -->\n<!-- t3bot:section kind="tagged" -->',
      { start: { kind: "tagged", label: null }, end: false },
    ],
    // The last opening marker wins.
    [
      '<!-- t3bot:section kind="a" --><!-- t3bot:section kind="b-c" -->',
      { start: { kind: "b-c", label: null }, end: false },
    ],
    ['<!-- t3bot:section kind="Status Check" -->', null],
    ['<!-- t3bot:section label="No kind" -->', null],
    ["<!-- t3bot:section -->", null],
  ])("parses %j", (text, expected) => {
    expect(parseBotSectionMarkers(text)).toEqual(expected);
  });
});

describe("formatBotSectionLabel", () => {
  // Built from local wall-clock parts, so the label reads the same in every zone.
  const startedAt = DateTime.formatIso(
    DateTime.makeZonedUnsafe(
      { year: 2026, month: 11, day: 21, hour: 9, minute: 8, second: 4 },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    ),
  );

  it.each([
    [{ kind: "status-check", label: null }, "Status Check - 09:08:04"],
    [{ kind: "heartbeat", label: "Morning sweep" }, "Morning sweep - 09:08:04"],
  ])("labels %j in local time", (marker, expected) => {
    expect(formatBotSectionLabel(marker, startedAt)).toBe(expected);
  });

  it("drops an unreadable time", () => {
    expect(formatBotSectionLabel({ kind: "tagged", label: null }, "not a date")).toBe("Tagged");
  });
});

describe("deriveBotSectionSpans", () => {
  // u = user prompt, a = plain reply, w = work, S = opening marker, E = end marker, X = both.
  const spans = (items: string) =>
    deriveBotSectionSpans([...items], {
      startsTurn: (item) => item === "u",
      markers: (item) =>
        item === "S"
          ? { start: { kind: "status-check", label: null }, end: false }
          : item === "E"
            ? { start: null, end: true }
            : item === "X"
              ? { start: { kind: "status-check", label: null }, end: true }
              : null,
    }).map((span) => [span.startIndex, span.endIndex, span.closed]);

  it.each<[string, Array<[number, number, boolean]>]>([
    ["uaua", []],
    // Opens at the prompt of its own turn and stays open to the end.
    ["uauwSua", [[2, 6, false]]],
    // The next marker's turn closes it.
    [
      "uSuauS",
      [
        [0, 3, true],
        [4, 5, false],
      ],
    ],
    // An end marker closes it, inclusive; later turns stay outside.
    ["uSuEua", [[0, 3, true]]],
    ["uXua", [[0, 1, true]]],
    // A marker before any prompt starts at the first item.
    ["wSua", [[0, 3, false]]],
    // Two markers in one turn split after the first.
    [
      "uSwS",
      [
        [0, 1, true],
        [2, 3, false],
      ],
    ],
    // A marker right after an end in the same turn starts after the end.
    [
      "uSEwS",
      [
        [0, 2, true],
        [3, 4, false],
      ],
    ],
    ["uEua", []],
  ])("spans %j", (items, expected) => {
    expect(spans(items)).toEqual(expected);
  });
});
