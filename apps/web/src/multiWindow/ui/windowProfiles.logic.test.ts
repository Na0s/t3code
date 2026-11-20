import { describe, expect, it } from "vite-plus/test";

import { normalizeWindowProfileName } from "./windowProfiles.logic";

describe("normalizeWindowProfileName", () => {
  it.each([
    ["  Work  ", "Work"],
    ["   ", null],
    ["x".repeat(80), "x".repeat(80)],
    ["x".repeat(81), null],
  ])("normalizes %j", (name, expected) => {
    expect(normalizeWindowProfileName(name)).toBe(expected);
  });
});
