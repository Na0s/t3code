import { describe, expect, it } from "vite-plus/test";

import {
  normalizeWindowProfileName,
  themeFromSelectValue,
  themeSelectValue,
  windowCloseDecision,
} from "./windowProfiles.logic";

describe("windowCloseDecision", () => {
  it.each([
    ["save", "  Work  ", { action: "save", name: "Work" }],
    ["save", "   ", null],
    ["save", "x".repeat(81), null],
    ["discard", "", { action: "discard" }],
    ["cancel", "", { action: "cancel" }],
  ] as const)("maps %s with %j", (choice, name, expected) => {
    expect(windowCloseDecision(choice, name)).toEqual(expected);
  });
});

describe("normalizeWindowProfileName", () => {
  it("accepts names up to the shell's limit", () => {
    expect(normalizeWindowProfileName("x".repeat(80))).toBe("x".repeat(80));
  });
});

describe("theme select values", () => {
  it.each([null, "system", "dracula"])("round-trips %j", (theme) => {
    expect(themeFromSelectValue(themeSelectValue(theme))).toBe(theme);
  });
});
