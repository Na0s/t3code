import type {
  DesktopOpenWindow,
  DesktopWindowProfile,
  DesktopWindowsBridge,
} from "@t3tools/contracts";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { desktopWindowsBridge, readDesktopWindowContext } from "../../multiWindow/windowContext";
import { selectCurrentWindow, useDesktopWindowsState } from "../../multiWindow/windowsState";
import { notifyWindowActionFailure } from "../../multiWindow/ui/windowActions";
import {
  normalizeWindowProfileName,
  themeFromSelectValue,
  themeSelectValue,
  WINDOW_PROFILE_NAME_MAX_LENGTH,
} from "../../multiWindow/ui/windowProfiles.logic";
import { useThemeCards } from "../CommandPaletteThemeItems";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Saved desktop windows; renders nothing outside a multi-window desktop shell. */
export function WindowsSettingsSection() {
  const [bridge] = useState(desktopWindowsBridge);
  const windowsState = useDesktopWindowsState();
  if (bridge === null) return null;
  const context = readDesktopWindowContext();
  const currentWindow = selectCurrentWindow(windowsState, context);
  const profiles = (windowsState?.profiles ?? []).toSorted(
    (left, right) => Number(right.isDefault) - Number(left.isDefault),
  );

  return (
    <SettingsSection id="windows" title="Windows">
      {currentWindow !== null && !currentWindow.isMain && currentWindow.profileId === null ? (
        <SaveCurrentWindowRow bridge={bridge} suggestedName={currentWindow.name} />
      ) : null}
      {profiles.map((profile) => (
        <WindowProfileRow
          key={profile.id}
          bridge={bridge}
          profile={profile}
          openWindow={windowsState?.windows.find((window) => window.profileId === profile.id)}
          isCurrentWindow={
            currentWindow === null
              ? context?.profileId === profile.id
              : currentWindow.profileId === profile.id
          }
        />
      ))}
    </SettingsSection>
  );
}

function SaveCurrentWindowRow({
  bridge,
  suggestedName,
}: {
  readonly bridge: DesktopWindowsBridge;
  readonly suggestedName: string;
}) {
  const [name, setName] = useState(suggestedName);
  const [saving, setSaving] = useState(false);
  const normalized = normalizeWindowProfileName(name);
  const save = () => {
    if (normalized === null || saving) return;
    setSaving(true);
    bridge
      .saveAsProfile(normalized)
      .catch((cause: unknown) => notifyWindowActionFailure("Couldn't save this window", cause))
      .finally(() => setSaving(false));
  };
  return (
    <SettingsRow
      title="Save this window"
      description="Keep this window's project filter and theme so you can reopen it later."
      control={
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Input
            size="sm"
            className="w-full sm:w-44"
            aria-label="Window name"
            maxLength={WINDOW_PROFILE_NAME_MAX_LENGTH}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              save();
            }}
          />
          <Button size="sm" disabled={normalized === null || saving} onClick={save}>
            Save
          </Button>
        </div>
      }
    />
  );
}

function WindowProfileRow({
  bridge,
  profile,
  openWindow,
  isCurrentWindow,
}: {
  readonly bridge: DesktopWindowsBridge;
  readonly profile: DesktopWindowProfile;
  readonly openWindow: DesktopOpenWindow | undefined;
  readonly isCurrentWindow: boolean;
}) {
  const status = isCurrentWindow
    ? "This window"
    : profile.isDefault || openWindow !== undefined
      ? "Open"
      : "Closed";
  const deleteProfile = async () => {
    const confirmed = await requestConfirmDialog(
      `Delete the saved window "${profile.name}"?\nIf it is open, it stays open as an unsaved window.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    await bridge.deleteProfile(profile.id).catch((cause: unknown) => {
      notifyWindowActionFailure("Couldn't delete the saved window", cause);
    });
  };

  return (
    <SettingsRow
      title={profile.isDefault ? `${profile.name} (main window)` : profile.name}
      description={status}
      control={
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
          <ProfileNameInput bridge={bridge} profile={profile} />
          {profile.isDefault ? null : <ProfileThemeSelect bridge={bridge} profile={profile} />}
          {isCurrentWindow ? null : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                bridge.openProfile(profile.id).catch((cause: unknown) => {
                  notifyWindowActionFailure("Couldn't open the window", cause);
                });
              }}
            >
              {status === "Open" ? "Focus" : "Open"}
            </Button>
          )}
          {profile.isDefault ? null : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost-destructive"
                    aria-label={`Delete ${profile.name}`}
                    onClick={() => void deleteProfile()}
                  />
                }
              >
                <Trash2Icon />
              </TooltipTrigger>
              <TooltipPopup side="top">Delete saved window</TooltipPopup>
            </Tooltip>
          )}
        </div>
      }
    />
  );
}

function ProfileNameInput({
  bridge,
  profile,
}: {
  readonly bridge: DesktopWindowsBridge;
  readonly profile: DesktopWindowProfile;
}) {
  const [draft, setDraft] = useState({ base: profile.name, value: profile.name });
  if (draft.base !== profile.name) setDraft({ base: profile.name, value: profile.name });
  const commit = () => {
    const name = normalizeWindowProfileName(draft.value);
    if (name === null || name === profile.name) {
      setDraft({ base: profile.name, value: profile.name });
      return;
    }
    bridge.updateProfile({ profileId: profile.id, name }).catch((cause: unknown) => {
      notifyWindowActionFailure("Couldn't rename the window", cause);
      setDraft({ base: profile.name, value: profile.name });
    });
  };
  return (
    <Input
      size="sm"
      className="w-full sm:w-40"
      aria-label={`Name of ${profile.name}`}
      maxLength={WINDOW_PROFILE_NAME_MAX_LENGTH}
      value={draft.value}
      onChange={(event) => setDraft({ base: profile.name, value: event.target.value })}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setDraft({ base: profile.name, value: profile.name });
        }
      }}
    />
  );
}

function ProfileThemeSelect({
  bridge,
  profile,
}: {
  readonly bridge: DesktopWindowsBridge;
  readonly profile: DesktopWindowProfile;
}) {
  const themeCards = useThemeCards();
  const options = [
    { value: themeSelectValue(null), label: "Follow main window" },
    ...themeCards.map((card) => ({ value: card.id ?? "system", label: card.label })),
  ];
  const value = themeSelectValue(profile.theme);
  const selectedLabel =
    options.find((option) => option.value === value)?.label ?? profile.theme ?? "";
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (typeof next !== "string" || next === value) return;
        bridge
          .updateProfile({ profileId: profile.id, theme: themeFromSelectValue(next) })
          .catch((cause: unknown) => {
            notifyWindowActionFailure("Couldn't change the window theme", cause);
          });
      }}
    >
      <SelectTrigger size="sm" className="w-full sm:w-44" aria-label={`Theme of ${profile.name}`}>
        <SelectValue>{selectedLabel}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem hideIndicator key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
