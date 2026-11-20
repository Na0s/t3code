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
