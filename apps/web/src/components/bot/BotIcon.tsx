import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { msg } from "gt-react";

import { cn } from "~/lib/utils";
import { projectIconColorClassName } from "../../projectIconColors";
import { ProjectFavicon } from "../ProjectFavicon";
import { botColor, type BotHealth } from "./BotShell.logic";

const HEALTH_DOT_CLASS: Record<BotHealth, string> = {
  attention: "bg-warning",
  failed: "bg-destructive",
  unread: "bg-success",
  working: "bg-info",
  idle: "bg-muted-foreground/50",
};

/** `msg()` labels; resolve them with `useMessages()` where they render. */
export const BOT_HEALTH_LABEL: Record<BotHealth, string> = {
  attention: msg("Needs you"),
  failed: msg("Failed", { $context: "bot status" }),
  unread: msg("Unread", { $context: "bot status" }),
  working: msg("Working", { $context: "bot status" }),
  idle: msg("Idle", { $context: "bot status" }),
};

const SIZE_CLASS = {
  sm: { box: "size-5 text-3xs", art: "size-3", dot: "size-1.5" },
  md: { box: "size-7 text-xs", art: "size-4", dot: "size-2" },
  lg: { box: "size-10 text-base", art: "size-6", dot: "size-2.5" },
} as const;

/**
 * A bot's icon in a square box. A monogram, or no icon, draws as the circle inscribed in that
 * square; a chosen icon or favicon fills the square itself.
 */
export function BotIcon(props: {
  readonly project: Pick<
    EnvironmentProject,
    "environmentId" | "workspaceRoot" | "title" | "faviconPath" | "projectIcon"
  >;
  readonly size?: keyof typeof SIZE_CLASS;
  readonly health?: BotHealth | null;
  readonly className?: string;
}) {
  const { project } = props;
  const size = SIZE_CLASS[props.size ?? "md"];
  const colorClassName = projectIconColorClassName(botColor(project));
  const icon = project.projectIcon;
  const circle = icon == null || icon.kind === "monogram";
  const letters =
    icon?.kind === "monogram"
      ? Array.from(icon.text).slice(0, 2).join("")
      : (Array.from(project.title.trim())[0] ?? "?");
  return (
    <span
      aria-hidden="true"
      className={cn("relative inline-flex shrink-0", size.box, props.className)}
    >
      <span
        className={cn(
          "inline-flex size-full items-center justify-center border-2 border-current font-semibold select-none",
          circle ? "rounded-full" : "rounded-[25%]",
          colorClassName,
        )}
      >
        {circle ? letters.toUpperCase() : <ProjectFavicon project={project} className={size.art} />}
      </span>
      {props.health ? (
        <span
          className={cn(
            "absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-background",
            size.dot,
            HEALTH_DOT_CLASS[props.health],
          )}
        />
      ) : null}
    </span>
  );
}
