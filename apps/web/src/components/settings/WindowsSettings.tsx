import type {
  DesktopOpenWindow,
  DesktopWindowProfile,
  DesktopWindowsBridge,
} from "@t3tools/contracts";
import { CheckIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { desktopWindowsBridge, readDesktopWindowContext } from "../../multiWindow/windowContext";
import { selectCurrentWindow, useDesktopWindowsState } from "../../multiWindow/windowsState";
import { useProjectScopeGroups } from "../../multiWindow/ui/useProjectScopeGroups";
import { notifyWindowActionFailure } from "../../multiWindow/ui/windowActions";
import {
  normalizeWindowProfileName,
  themeFromSelectValue,
  themeSelectValue,
  WINDOW_PROFILE_NAME_MAX_LENGTH,
} from "../../multiWindow/ui/windowProfiles.logic";
import { useThemeCards } from "../CommandPaletteThemeItems";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type ProjectScopeGroups = ReturnType<typeof useProjectScopeGroups>;

/** Saved desktop windows; renders nothing outside a multi-window desktop shell. */
export function WindowsSettingsSection() {
  const [bridge] = useState(desktopWindowsBridge);
  return bridge === null ? null : <WindowsSettingsContent bridge={bridge} />;
}

function WindowsSettingsContent({ bridge }: { readonly bridge: DesktopWindowsBridge }) {
  const windowsState = useDesktopWindowsState();
  const projectGroups = useProjectScopeGroups();
  const [creating, setCreating] = useState(false);
  const context = readDesktopWindowContext();
  const currentWindow = selectCurrentWindow(windowsState, context);
  const profiles = windowsState?.profiles ?? [];
  const mainProfile = profiles.find((profile) => profile.isDefault);
  const savedProfiles = profiles.filter((profile) => !profile.isDefault);
  const multiWindowEnabled = windowsState?.multiWindowEnabled !== false;
  const isCurrentWindow = (profile: DesktopWindowProfile) =>
    currentWindow === null
      ? context?.profileId === profile.id
      : currentWindow.profileId === profile.id;

  return (
    <SettingsSection
      id="windows"
      title="Windows"
      headerAction={
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={creating}
          onClick={() => setCreating(true)}
        >
          <PlusIcon className="size-3" />
          Add saved window
        </Button>
      }
    >
      <SettingsRow
        title="Multiple windows"
        description="Open more windows that share this app's connections. Turning this off keeps open windows open."
        control={
          <Switch
            checked={multiWindowEnabled}
            disabled={windowsState === null}
            aria-label="Multiple windows"
            onCheckedChange={(checked) => {
              bridge.setMultiWindowEnabled(checked).catch((cause: unknown) => {
                notifyWindowActionFailure("Couldn't change multiple windows", cause);
              });
            }}
          />
        }
      />
      {currentWindow !== null && !currentWindow.isMain && currentWindow.profileId === null ? (
        <SaveCurrentWindowRow bridge={bridge} suggestedName={currentWindow.name} />
      ) : null}
      {mainProfile === undefined ? null : (
        <WindowProfileRow
          bridge={bridge}
          profile={mainProfile}
          projectGroups={projectGroups}
          openWindow={undefined}
          isCurrentWindow={isCurrentWindow(mainProfile)}
          canOpen
        />
      )}
      {savedProfiles.length > 0 || creating ? (
        // Saved windows nest under the main window, whose renderer serves them.
        <div className="ps-5 sm:ps-7">
          <div className="border-s border-border/60 *:not-first:border-t *:not-first:border-border/50 [&>[data-slot=settings-row]]:rounded-none">
            {savedProfiles.map((profile) => (
              <WindowProfileRow
                key={profile.id}
                bridge={bridge}
                profile={profile}
                projectGroups={projectGroups}
                openWindow={windowsState?.windows.find((window) => window.profileId === profile.id)}
                isCurrentWindow={isCurrentWindow(profile)}
                canOpen={multiWindowEnabled}
              />
            ))}
            {creating ? (
              <NewWindowProfileRow
                bridge={bridge}
                projectGroups={projectGroups}
                onDone={() => setCreating(false)}
              />
            ) : null}
          </div>
        </div>
      ) : null}
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

function projectFilterSummary(projectGroups: ProjectScopeGroups, keys: readonly string[]): string {
  const names = projectGroups.groupsForKeys(keys).map((group) => group.displayName);
  return names.length === 0 ? "All projects" : names.join(", ");
}

function WindowProfileRow({
  bridge,
  profile,
  projectGroups,
  openWindow,
  isCurrentWindow,
  canOpen,
}: {
  readonly bridge: DesktopWindowsBridge;
  readonly profile: DesktopWindowProfile;
  readonly projectGroups: ProjectScopeGroups;
  readonly openWindow: DesktopOpenWindow | undefined;
  readonly isCurrentWindow: boolean;
  readonly canOpen: boolean;
}) {
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
  const isOpen = profile.isDefault || openWindow !== undefined;

  return (
    <SettingsRow
      title={profile.isDefault ? `${profile.name} (main window)` : profile.name}
      description={
        profile.isDefault
          ? "Holds the connections and drafts every window shares."
          : projectFilterSummary(projectGroups, profile.projectScopeKeys)
      }
      control={
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
          <ProfileNameInput bridge={bridge} profile={profile} />
          {profile.isDefault ? null : (
            <WindowThemeSelect
              value={profile.theme}
              hasProjectFilter={profile.projectScopeKeys.length > 0}
              ariaLabel={`Theme of ${profile.name}`}
              onChange={(theme) => {
                bridge.updateProfile({ profileId: profile.id, theme }).catch((cause: unknown) => {
                  notifyWindowActionFailure("Couldn't change the window theme", cause);
                });
              }}
            />
          )}
          {isCurrentWindow || !canOpen ? null : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                bridge.openProfile(profile.id).catch((cause: unknown) => {
                  notifyWindowActionFailure("Couldn't open the window", cause);
                });
              }}
            >
              {isOpen ? "Focus" : "Open"}
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

function NewWindowProfileRow({
  bridge,
  projectGroups,
  onDone,
}: {
  readonly bridge: DesktopWindowsBridge;
  readonly projectGroups: ProjectScopeGroups;
  readonly onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [projectScopeKeys, setProjectScopeKeys] = useState<readonly string[]>([]);
  const [theme, setTheme] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const normalized = normalizeWindowProfileName(name);
  const create = () => {
    if (normalized === null || saving) return;
    setSaving(true);
    bridge.createProfile({ name: normalized, projectScopeKeys, theme }).then(
      () => onDone(),
      (cause: unknown) => {
        notifyWindowActionFailure("Couldn't save the window", cause);
        setSaving(false);
      },
    );
  };
  return (
    <SettingsRow
      title="New saved window"
      description="Open it later from here, the command palette or the Window menu."
      control={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button size="sm" disabled={normalized === null || saving} onClick={create}>
            Save
          </Button>
        </div>
      }
    >
      <div className="grid gap-3 pt-1 pb-3 sm:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="new-window-profile-name">Name</Label>
          <Input
            id="new-window-profile-name"
            size="sm"
            autoFocus
            maxLength={WINDOW_PROFILE_NAME_MAX_LENGTH}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              create();
            }}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label render={<span />}>Projects</Label>
          <ProjectFilterSelect
            projectGroups={projectGroups}
            value={projectScopeKeys}
            onChange={setProjectScopeKeys}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label render={<span />}>Theme</Label>
          <WindowThemeSelect
            value={theme}
            hasProjectFilter={projectScopeKeys.length > 0}
            ariaLabel="Theme of the new window"
            fullWidth
            onChange={setTheme}
          />
        </div>
      </div>
    </SettingsRow>
  );
}

function ProjectFilterSelect({
  projectGroups,
  value,
  onChange,
}: {
  readonly projectGroups: ProjectScopeGroups;
  readonly value: readonly string[];
  readonly onChange: (keys: readonly string[]) => void;
}) {
  return (
    <Select
      multiple
      value={[...value]}
      onValueChange={(next) => {
        if (Array.isArray(next)) onChange(next.filter((key) => typeof key === "string"));
      }}
    >
      <SelectTrigger size="sm" aria-label="Projects of the new window">
        <SelectValue>{projectFilterSummary(projectGroups, value)}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {projectGroups.groups.map((group) => (
          <SelectItem key={group.projectKey} value={group.projectKey}>
            <span className="flex min-w-0 items-center gap-2">
              <ProjectFavicon project={group} />
              <span className="min-w-0 flex-1 truncate">{group.displayName}</span>
              {value.includes(group.projectKey) ? <CheckIcon className="size-3.5" /> : null}
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function WindowThemeSelect({
  value,
  hasProjectFilter,
  ariaLabel,
  fullWidth = false,
  onChange,
}: {
  readonly value: string | null;
  readonly hasProjectFilter: boolean;
  readonly ariaLabel: string;
  readonly fullWidth?: boolean;
  readonly onChange: (theme: string | null) => void;
}) {
  const themeCards = useThemeCards();
  const options = [
    // Without a project filter there is no project colour to take on.
    {
      value: themeSelectValue(null),
      label: hasProjectFilter ? "Project colour" : "Follow main window",
    },
    ...themeCards.map((card) => ({ value: card.id ?? "system", label: card.label })),
  ];
  const selectValue = themeSelectValue(value);
  const selectedLabel =
    options.find((option) => option.value === selectValue)?.label ?? value ?? "";
  return (
    <Select
      value={selectValue}
      onValueChange={(next) => {
        if (typeof next !== "string" || next === selectValue) return;
        onChange(themeFromSelectValue(next));
      }}
    >
      <SelectTrigger
        size="sm"
        className={fullWidth ? "w-full" : "w-full sm:w-44"}
        aria-label={ariaLabel}
      >
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
