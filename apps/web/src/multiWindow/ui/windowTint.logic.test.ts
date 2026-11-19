import { describe, expect, it } from "vite-plus/test";

import { projectIconSwatch } from "../../projectIconColors";
import { deriveProjectIdentity } from "../../projectIdentity";
import {
  projectIconTintColor,
  projectTintColors,
  rightFadeBackground,
  tintBackground,
  type WindowTintProject,
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
const automatic = (title: string): WindowTintProject => ({ title, projectIcon: null });

describe("projectIconTintColor", () => {
  it("uses the icon's colour, the name's monogram colour without one, and none for an emoji", () => {
    expect(projectIconTintColor(monogram("api", "rose"), false)).toBe("rose");
    expect(projectIconTintColor(lucide("api", "amber"), false)).toBe("amber");
    expect(projectIconTintColor(automatic("storefront"), false)).toBe(
      deriveProjectIdentity("storefront").color,
    );
    expect(projectIconTintColor(emoji, false)).toBeNull();
  });

  it("has no colour for a project whose icon is an image", () => {
    expect(projectIconTintColor(automatic("storefront"), true)).toBeNull();
    // An override replaces the image, so its colour shows.
    expect(projectIconTintColor(monogram("api", "rose"), true)).toBe("rose");
  });
});

describe("projectTintColors", () => {
  it("lists each colour once, in project order, skipping emoji and image icons", () => {
    const image = automatic("brand-site");
    expect(
      projectTintColors(
        [monogram("api", "rose"), emoji, image, monogram("web", "green"), monogram("docs", "rose")],
        (project) => project === image,
      ),
    ).toEqual([projectIconSwatch("rose"), projectIconSwatch("green")]);
  });

  it("is empty when no project shows a colour", () => {
    const image = automatic("brand-site");
    expect(projectTintColors([emoji, image], (project) => project === image)).toEqual([]);
  });
});

describe("rightFadeBackground", () => {
  it("fades one colour from the right edge to nothing at the left", () => {
    expect(rightFadeBackground(["red"], 16)).toBe(
      "linear-gradient(to left, color-mix(in oklab, red 16%, transparent) 0%, transparent)",
    );
  });

  it("keeps several colours in order left to right, fainter towards the left", () => {
    expect(rightFadeBackground(["red", "blue"], 16)).toBe(
      "linear-gradient(to left, color-mix(in oklab, blue 16%, transparent) 0%, color-mix(in oklab, red 8%, transparent) 50%, transparent)",
    );
  });
});

describe("tintBackground", () => {
  it("fills with one colour and blends several left to right", () => {
    expect(tintBackground(["red"])).toBe("red");
    expect(tintBackground(["red", "blue"])).toBe("linear-gradient(to right, red, blue)");
  });
});
