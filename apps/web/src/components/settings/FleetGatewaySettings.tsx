import { useRef } from "react";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function FleetGatewaySettings() {
  const command = useScopedSettings((settings) => settings.fleetGatewayCommand);
  const mixed = useScopedSettingsMixed(["fleetGatewayCommand"]);
  const update = useUpdateScopedSettings();
  const edited = useRef(false);
  return (
    <SettingsRow
      serverScoped
      settingKeys={["fleetGatewayCommand"]}
      {...searchableSetting("fleet-gateway")}
      description="Mention your Grokbots in the @ picker. Enter the gateway executable on this machine, followed by one argument per line. Leave empty to disconnect."
      resetAction={
        command.length > 0 || mixed ? (
          <SettingResetButton
            label="Fleet gateway"
            onClick={() => update({ fleetGatewayCommand: [] })}
          />
        ) : null
      }
    >
      <div className="mt-3 max-w-2xl pb-3.5">
        <Textarea
          key={`${mixed}:${JSON.stringify(command)}`}
          aria-label="Fleet gateway command"
          rows={3}
          defaultValue={mixed ? "" : command.join("\n")}
          onChange={() => {
            edited.current = true;
          }}
          placeholder={
            mixed ? "Mixed. Enter a command for the selected machines." : "t3-fleet-gateway"
          }
          onBlur={(event) => {
            if (!edited.current) return;
            edited.current = false;
            const next = event.target.value
              .split("\n")
              .map((part) => part.trim())
              .filter(Boolean);
            if (JSON.stringify(next) !== JSON.stringify(command) || mixed)
              update({ fleetGatewayCommand: next });
          }}
        />
      </div>
    </SettingsRow>
  );
}
