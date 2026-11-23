import type { ProjectIconColor, ProjectIconOverride } from "@t3tools/contracts";

import { projectIconSwatch } from "../../projectIconColors";
import { deriveProjectIdentity } from "../../projectIdentity";

export interface WindowTintProject {
  readonly title: string;
  readonly projectIcon?: ProjectIconOverride | null | undefined;
}

/** The colour the project's icon shows; an emoji or an image shows none. */
export function projectIconTintColor(
  project: WindowTintProject,
  showsImage: boolean,
): ProjectIconColor | null {
  const icon = project.projectIcon;
  // Without an override the icon is the project's image, or else the name's monogram in this colour.
  if (icon == null) return showsImage ? null : deriveProjectIdentity(project.title).color;
  return icon.kind === "emoji" ? null : icon.color;
}

/** Each distinct colour the projects' icons show, as a CSS colour, in project order. */
export function projectTintColors<TProject extends WindowTintProject>(
  projects: readonly TProject[],
  showsImage: (project: TProject) => boolean,
): string[] {
  return [
    ...new Set(
      projects.flatMap((project) => projectIconTintColor(project, showsImage(project)) ?? []),
    ),
  ].map(projectIconSwatch);
}

/**
 * A faint wash strongest at the right edge, fading to nothing at the left. Several colours keep
 * their left-to-right order, each fainter than the one to its right.
 */
export function rightFadeBackground(colors: readonly string[], percent: number): string {
  const stops = colors.toReversed().map((color, index) => {
    const share = index / colors.length;
    return `color-mix(in oklab, ${color} ${percent * (1 - share)}%, transparent) ${share * 100}%`;
  });
  return `linear-gradient(to left, ${[...stops, "transparent"].join(", ")})`;
}

/** One colour fills; several blend left to right in order. */
export function tintBackground(colors: readonly string[]): string {
  const [only] = colors;
  return colors.length === 1 && only !== undefined
    ? only
    : `linear-gradient(to right, ${colors.join(", ")})`;
}
