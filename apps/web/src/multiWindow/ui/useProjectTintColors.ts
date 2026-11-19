import { useAtomValue } from "@effect/atom-react";
import type { ProjectFaviconTarget } from "@t3tools/client-runtime/project-favicon-cache";
import { isProjectFaviconFallbackUrl } from "@t3tools/shared/projectFavicon";
import { Atom } from "effect/reactivity";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { projectFaviconUrlAtom } from "../../state/assets";
import { projectTintColors } from "./windowTint.logic";

// Keyed by the JSON of the projects' icon targets, so one atom reads every project's icon.
const projectsShowImageAtom = Atom.family((key: string) =>
  Atom.make((get) =>
    (JSON.parse(key) as ProjectFaviconTarget[]).map((target) => {
      // As `ProjectFavicon` decides: a fallback URL draws the monogram, not an image.
      const src = get(projectFaviconUrlAtom(target));
      return src !== null && !isProjectFaviconFallbackUrl(src);
    }),
  ),
);

/** The distinct colours the projects' icons show, in order; emoji and image icons show none. */
export function useProjectTintColors(projects: readonly SidebarProjectSnapshot[]): string[] {
  // Only a project without an icon override can show an image.
  const automatic = projects.filter((project) => project.projectIcon == null);
  const showsImage = useAtomValue(
    projectsShowImageAtom(
      JSON.stringify(
        automatic.map((project): ProjectFaviconTarget => ({
          environmentId: project.environmentId,
          cwd: project.workspaceRoot,
          faviconPath: project.faviconPath ?? null,
        })),
      ),
    ),
  );
  return projectTintColors(projects, (project) => showsImage[automatic.indexOf(project)] === true);
}
