import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";

import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { nextBotSettings } from "./ProjectSettingsPanel.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Turns the project into a T3_BOT identity, which moves it out of the main window's lists. */
export function ProjectBotSettings({
  members,
}: {
  members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  const gt = useGT();
  const { environments } = useEnvironments();
  const writableIds = useEnvironmentsWithScope(members, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "T3_BOT update",
  });
  const [saving, setSaving] = useState(false);
  const botsByEnvironment = new Map(
    environments.map((environment) => [
      environment.environmentId,
      environment.serverConfig?.settings.bots,
    ]),
  );
  const entries = members.map((member) => botsByEnvironment.get(member.environmentId)?.[member.id]);
  const isBot = entries.every((entry) => entry !== undefined);
  const role = entries.find((entry) => entry?.role !== undefined)?.role ?? "";
  const canEdit = members.every(
    (member) =>
      writableIds.has(member.environmentId) &&
      botsByEnvironment.get(member.environmentId) !== undefined,
  );

  const save = async (edit: Parameters<typeof nextBotSettings>[1]) => {
    setSaving(true);
    for (const member of members) {
      const current = botsByEnvironment.get(member.environmentId)?.[member.id];
      const result = await updateSettings({
        environmentId: member.environmentId,
        input: { patch: { bots: { [member.id]: nextBotSettings(current, edit) } } },
      });
      if (result._tag === "Failure") break;
    }
    setSaving(false);
  };

  return (
    // oxlint-disable-next-line t3code/no-untranslated-copy -- T3_BOT is the feature's name
    <SettingsSection title="T3_BOT">
      {!canEdit ? (
        <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
          <T>This connection cannot change environment settings.</T>
        </p>
      ) : null}
      <SettingsRow
        title={gt("Use as a T3_BOT")}
        description={gt(
          "The project and its threads move from the sidebar and pickers to the T3_BOT window. Its threads become the bot's conversations.",
        )}
        control={
          <Switch
            checked={isBot}
            disabled={!canEdit || saving}
            onCheckedChange={(checked) => void save({ enabled: Boolean(checked) })}
            aria-label={gt("Use as a T3_BOT")}
          />
        }
      />
      <SettingsRow
        title={gt("Role", { $context: "bot role" })}
        description={gt("What this bot is for, shown in the T3_BOT window.")}
        control={
          <Input
            key={`${isBot}:${role}`}
            size="sm"
            className="w-full sm:w-64"
            aria-label={gt("T3_BOT role")}
            placeholder={
              isBot
                ? gt("Orchestrator", { $context: "example bot role" })
                : gt("Turn on T3_BOT first")
            }
            disabled={!canEdit || saving || !isBot}
            defaultValue={role}
            onBlur={(event) => {
              const next = event.currentTarget.value;
              if (next.trim() !== role) void save({ role: next });
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        }
      />
    </SettingsSection>
  );
}
