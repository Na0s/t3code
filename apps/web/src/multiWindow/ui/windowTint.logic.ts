import type { ProjectIconColor, ProjectIconOverride } from "@t3tools/contracts";

import { projectIconSwatch } from "../../projectIconColors";
import { deriveProjectIdentity } from "../../projectIdentity";

export type WindowTint =
  | { readonly kind: "none" }
  /** One colour: the window's theme takes it on as its accent and surface hue. */
  | { readonly kind: "solid"; readonly color: string }
  /** Several colours: a left-to-right overlay on the theme, in filter order. */
  | { readonly kind: "gradient"; readonly colors: readonly string[] };

const NO_TINT: WindowTint = { kind: "none" };

export interface WindowTintProject {
  readonly title: string;
  readonly projectIcon?: ProjectIconOverride | null | undefined;
}

/** The colour the project's icon shows; an emoji icon has none. */
export function projectIconTintColor(project: WindowTintProject): ProjectIconColor | null {
  const icon = project.projectIcon;
  if (icon?.kind === "emoji") return null;
  if (icon != null) return icon.color;
  // Without an override the icon is a favicon or the name's monogram, which uses this colour.
  return deriveProjectIdentity(project.title).color;
}

/**
 * A secondary window without its own saved theme takes on its filtered projects' icon colours.
 * The main window, an unfiltered window and an explicit theme stay untinted.
 */
export function resolveWindowTint(input: {
  readonly isSecondaryWindow: boolean;
  readonly explicitTheme: string | null;
  readonly projects: readonly WindowTintProject[];
}): WindowTint {
  if (!input.isSecondaryWindow || input.explicitTheme !== null) return NO_TINT;
  const colors = [
    ...new Set(input.projects.flatMap((project) => projectIconTintColor(project) ?? [])),
  ].map(projectIconSwatch);
  const [first] = colors;
  if (first === undefined) return NO_TINT;
  return colors.length === 1 ? { kind: "solid", color: first } : { kind: "gradient", colors };
}

const LIGHT_OVERLAY_PERCENT = 12;
const DARK_OVERLAY_PERCENT = 16;

/** Translucent stops, so the theme's own colours still read through the overlay. */
export function windowTintGradient(
  colors: readonly string[],
  appearance: "light" | "dark",
): string {
  const percent = appearance === "dark" ? DARK_OVERLAY_PERCENT : LIGHT_OVERLAY_PERCENT;
  const stops = colors.map((color) => `color-mix(in oklab, ${color} ${percent}%, transparent)`);
  return `linear-gradient(to right, ${stops.join(", ")})`;
}
