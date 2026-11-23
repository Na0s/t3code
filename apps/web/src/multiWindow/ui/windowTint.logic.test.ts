import { describe, expect, it } from "vite-plus/test";

import { projectIconSwatch } from "../../projectIconColors";
import { deriveProjectIdentity } from "../../projectIdentity";
import {
  projectIconTintColor,
  projectTintColors,
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
