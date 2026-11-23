import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { BotContextRecord, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { BotIcon as BotGlyph, CheckIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useProject } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { BotIcon } from "./bot/BotIcon";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** A bot's own icon, or a generic one while its project is unknown here. */
export function BotMentionIcon(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  className?: string;
}) {
  const project = useProject(scopeProjectRef(props.environmentId, props.projectId));
  return project ? (
    <BotIcon
      project={project}
      size="sm"
      {...(props.className ? { className: props.className } : {})}
    />
  ) : (
    <BotGlyph aria-hidden="true" className={cn("shrink-0", props.className)} />
  );
}

/**
 * Inline chip for a tagged bot. In the composer it says the bot gets the message on send; in a
 * sent message it says the bot's server was told to deliver it.
 */
export function BotContextChip(props: {
  record: Pick<BotContextRecord, "environmentId" | "projectId" | "label">;
  sent?: boolean;
  copyMarkdown?: string;
}) {
  const { environmentId, projectId } = props.record;
  const gt = useGT();
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const role = useAtomValue(serverEnvironment.settingsValueAtom(environmentId))?.bots[projectId]
    ?.role;
  const name = project?.title.trim() || props.record.label;
  const about = role?.trim() ? `T3_BOT · ${role.trim()}` : "T3_BOT";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="bot"
            tabIndex={0}
            aria-label={
              props.sent ? gt("Bot, {name}, notified", { name }) : gt("Bot, {name}", { name })
            }
            data-markdown-copy={props.copyMarkdown}
          >
            <BotMentionIcon
              environmentId={environmentId}
              projectId={projectId}
              className="size-[1em]"
            />
            <ContextChipLabel>{name}</ContextChipLabel>
            {props.sent ? <CheckIcon aria-hidden="true" /> : null}
          </ContextChip>
        }
      />
      <TooltipPopup side="top">
        {props.sent
          ? gt("Notified {name} ({about})", { name, about })
          : gt("{about}. Gets this message when you send.", { about })}
      </TooltipPopup>
    </Tooltip>
  );
}
