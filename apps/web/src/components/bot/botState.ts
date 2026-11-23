import { useAtomValue } from "@effect/atom-react";
import type { BotSettings, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { listBots, type Bot } from "./BotShell.logic";

type BotSettingsRecord = Readonly<Record<string, BotSettings | undefined>>;

const EMPTY_BOTS: BotSettingsRecord = Object.freeze({});

// Settings pushes rebuild the whole settings object; keep an unchanged bot list stable.
const environmentBotSettingsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) => get(serverEnvironment.settingsValueAtom(environmentId))?.bots ?? EMPTY_BOTS,
  ).pipe(
    Atom.withEquality((a, b) => a === b || JSON.stringify(a) === JSON.stringify(b)),
    Atom.withLabel(`web-bot-settings:${environmentId}`),
  ),
);

const botSettingsListAtom = environmentAtomList(
  "web-bot-settings-list",
  environmentBotSettingsAtom,
);

/** Bot projects across connected environments, in their configured order. */
export function useBots(): ReadonlyArray<Bot> {
  const projects = useProjects();
  const environmentIds = [
    ...new Set(projects.flatMap((project) => (project.isBot ? [project.environmentId] : []))),
  ].toSorted();
  const settingsList = useAtomValue(botSettingsListAtom(environmentIdsKey(environmentIds)));
  return listBots(
    projects,
    new Map(environmentIds.map((environmentId, index) => [environmentId, settingsList[index]!])),
  );
}
