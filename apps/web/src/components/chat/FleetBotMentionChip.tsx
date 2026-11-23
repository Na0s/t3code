import { contextChipAccentWithHueOf } from "~/themePalette";
import { T, useGT } from "gt-react";
import type { CSSProperties } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { FleetBotPresentation } from "@t3tools/shared/fleetBotMentions";
import { Atom } from "effect/reactivity";
import { serverEnvironment } from "~/state/server";
import { ContextChipPopover, ContextChipShell } from "../contextChipParts";

export const fleetBotIdsAtom = Atom.family((environmentId: string) =>
  Atom.make((get): ReadonlySet<string> => {
    const next = new Set(
      environmentId
        ? get(serverEnvironment.configValueAtom(environmentId as EnvironmentId))?.fleetBots?.map(
            (bot) => bot.id,
          )
        : [],
    );
    const previous = Option.getOrNull(get.self<ReadonlySet<string>>());
    return previous && previous.size === next.size && [...next].every((id) => previous.has(id))
      ? previous
      : next;
  }),
);

const fleetBotPresentationAtom = Atom.family((key: string) =>
  Atom.make((get): FleetBotPresentation | null => {
    const [environmentId, botId] = key.split("\u0000");
    const next = environmentId
      ? (get(serverEnvironment.configValueAtom(environmentId as EnvironmentId))?.fleetBots?.find(
          (bot) => bot.id === botId,
        ) ?? null)
      : null;
    const previous = Option.getOrNull(get.self<FleetBotPresentation | null>());
    return next &&
      previous &&
      next.id === previous.id &&
      next.name === previous.name &&
      next.icon === previous.icon &&
      next.color === previous.color
      ? previous
      : next;
  }),
);

export function FleetBotMentionChip(props: {
  environmentId: EnvironmentId | null;
  botId: string;
  source: string;
  inert?: boolean;
}) {
  const gt = useGT();
  const bot = useAtomValue(
    fleetBotPresentationAtom(`${props.environmentId ?? ""}\u0000${props.botId}`),
  );
  if (!bot) return props.source;
  const accent = contextChipAccentWithHueOf("model", bot.color) ?? bot.color;
  const icon = <span aria-hidden="true">{bot.icon}</span>;
  if (props.inert)
    return (
      <ContextChipShell
        kind="neutral"
        style={{ "--context-chip-accent": accent } as CSSProperties}
        icon={icon}
        label={bot.name}
        aria-label={gt("Grokbot {name}", { name: bot.name })}
      />
    );
  return (
    <ContextChipPopover
      kind="neutral"
      accent={accent}
      icon={icon}
      label={bot.name}
      accessibleLabel={gt("Grokbot {name}", { name: bot.name })}
      copyMarkdown={props.source}
    >
      <div className="space-y-1 p-2 text-sm">
        <p className="font-medium">{bot.name}</p>
        <p className="text-muted-foreground">
          <T>Fleet gateway</T>
        </p>
      </div>
    </ContextChipPopover>
  );
}
