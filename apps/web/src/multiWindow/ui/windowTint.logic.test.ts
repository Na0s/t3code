import { describe, expect, it } from "vite-plus/test";

import { projectIconSwatch } from "../../projectIconColors";
import { deriveProjectIdentity } from "../../projectIdentity";
import {
  projectIconTintColor,
  resolveWindowTint,
  type WindowTintProject,
  windowTintGradient,
} from "./windowTint.logic";

const monogram = (title: string, color: "blue" | "rose" | "green"): WindowTintProject => ({
  title,
  projectIcon: { kind: "monogram", text: title.slice(0, 2), color },
});
const lucide = (title: string, color: "amber"): WindowTintProject => ({
  title,
  projectIcon: { kind: "lucide", name: "folder", color },
});
const emoji: WindowTintProject = { title: "party", projectIcon: { kind: "emoji", emoji: "🎉" } };

describe("projectIconTintColor", () => {
  it("uses the icon's colour, the name's monogram colour without one, and none for an emoji", () => {
    expect(projectIconTintColor(monogram("api", "rose"))).toBe("rose");
    expect(projectIconTintColor(lucide("api", "amber"))).toBe("amber");
    expect(projectIconTintColor({ title: "storefront", projectIcon: null })).toBe(
      deriveProjectIdentity("storefront").color,
    );
    expect(projectIconTintColor(emoji)).toBeNull();
  });
});

describe("resolveWindowTint", () => {
  const tint = (input: Partial<Parameters<typeof resolveWindowTint>[0]>) =>
    resolveWindowTint({ isSecondaryWindow: true, explicitTheme: null, projects: [], ...input });

  it("takes on one project's colour", () => {
    expect(tint({ projects: [monogram("api", "blue")] })).toEqual({
      kind: "solid",
      color: projectIconSwatch("blue"),
    });
  });

  it("blends several projects left to right in filter order, once per colour", () => {
    expect(
      tint({
        projects: [
          monogram("api", "rose"),
          emoji,
          monogram("web", "green"),
          monogram("docs", "rose"),
        ],
      }),
    ).toEqual({
      kind: "gradient",
      colors: [projectIconSwatch("rose"), projectIconSwatch("green")],
    });
  });

  it("is a solid tint when several projects share one colour", () => {
    expect(tint({ projects: [monogram("api", "blue"), monogram("web", "blue")] })).toEqual({
      kind: "solid",
      color: projectIconSwatch("blue"),
    });
  });

  it.each([
    ["the main window", { isSecondaryWindow: false }],
    ["a saved explicit theme", { explicitTheme: "ember" }],
    ["no filter", { projects: [] }],
    ["only emoji icons", { projects: [emoji] }],
  ] as const)("leaves %s untinted", (_name, input) => {
    expect(
      tint({ projects: [monogram("api", "blue"), monogram("web", "green")], ...input }),
    ).toEqual({ kind: "none" });
  });
});

describe("windowTintGradient", () => {
  it("keeps each stop translucent so the theme shows through", () => {
    expect(windowTintGradient(["red", "blue"], "light")).toBe(
      "linear-gradient(to right, color-mix(in oklab, red 12%, transparent), color-mix(in oklab, blue 12%, transparent))",
    );
  });
});
