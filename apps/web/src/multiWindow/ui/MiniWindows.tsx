import type { DesktopOpenWindow } from "@t3tools/contracts";
import { ListFilterIcon } from "lucide-react";

import { APP_DISPLAY_NAME } from "../../branding";
import { ProjectFavicon, type ProjectFaviconProject } from "../../components/ProjectFavicon";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/utils";

export type MiniWindowProject = ProjectFaviconProject & {
  readonly projectKey: string;
  readonly displayName: string;
};

/** The other open windows as sidebar thread cards: filter, then window name, then what it shows. */
export function MiniWindows({
  windows,
  projectsFor,
  onFocusWindow,
}: {
  /** Null until the desktop shell reports its windows. */
  readonly windows: readonly DesktopOpenWindow[] | null;
  readonly projectsFor: (projectScopeKeys: readonly string[]) => readonly MiniWindowProject[];
  readonly onFocusWindow: (windowId: number) => void;
}) {
  return (
    <section aria-label="Windows" className="p-(--sidebar-content-inset)">
      {windows === null ? (
        <div role="status" aria-label="Loading windows" className="flex flex-col gap-2 p-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-40" />
        </div>
      ) : windows.length === 0 ? (
        <p className="px-(--sidebar-row-content-inset) py-2 text-secondary-label text-sm">
          No other windows are open.
        </p>
      ) : (
        <ul>
          {windows.map((window) => (
            <MiniWindowCard
              key={window.windowId}
              window={window}
              projects={projectsFor(window.projectScopeKeys)}
              onFocus={() => onFocusWindow(window.windowId)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function MiniWindowCard({
  window,
  projects,
  onFocus,
}: {
  readonly window: DesktopOpenWindow;
  readonly projects: readonly MiniWindowProject[];
  readonly onFocus: () => void;
}) {
  // The desktop shell appends the window's name to its title, and the card already leads with it.
  // What is left names the open thread, or only the app when the window has none open.
  const nameSuffix = ` - ${window.name}`;
  const shown = window.title.endsWith(nameSuffix)
    ? window.title.slice(0, -nameSuffix.length)
    : window.title;
  const title = shown === APP_DISPLAY_NAME ? "" : shown;
  return (
    <li className="py-0.5">
      <button
        type="button"
        aria-current={window.focused ? "true" : undefined}
        className={cn(
          "w-full cursor-pointer rounded-md px-(--sidebar-row-content-inset) py-(--sidebar-content-inset) text-left text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          window.focused
            ? "bg-sidebar-row-active light:ring-1 light:ring-sidebar-border/70 light:ring-inset"
            : "hover:bg-sidebar-row-hover",
        )}
        onClick={onFocus}
      >
        <span className="flex h-5 min-w-0 items-center gap-1.5 text-secondary-label text-xs">
          {projects.length === 0 ? (
            <ListFilterIcon aria-hidden className="size-4 shrink-0" />
          ) : (
            <span className="flex shrink-0">
              {projects.slice(0, 2).map((project, index) => (
                <span
                  key={project.projectKey}
                  className={index === 0 ? "flex" : "-ml-1 flex rounded-[25%] ring-2 ring-sidebar"}
                >
                  <ProjectFavicon project={project} className="size-4" />
                </span>
              ))}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate">
            {projects.length === 0
              ? "All projects"
              : projects.map((project) => project.displayName).join(", ")}
          </span>
          {window.focused ? (
            <span className="shrink-0 font-medium text-success-foreground">Focused</span>
          ) : (
            <span className="shrink-0">{window.profileId === null ? "Unsaved" : "Saved"}</span>
          )}
        </span>
        <span className="mt-1 block truncate font-medium text-sm">{window.name}</span>
        {title ? (
          <span className="mt-0.5 block truncate text-secondary-label text-xs">{title}</span>
        ) : null}
      </button>
    </li>
  );
}
