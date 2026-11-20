import type {
  DesktopOpenWindow,
  DesktopWindowProfile,
  DesktopWindowsBridge,
} from "@t3tools/contracts";
import { CheckIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState, type ComponentProps } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useRenderedAppearance } from "../../hooks/useTheme";
import { desktopWindowsBridge, readDesktopWindowContext } from "../../multiWindow/windowContext";
import { selectCurrentWindow, useDesktopWindowsState } from "../../multiWindow/windowsState";
import { useProjectScopeGroups } from "../../multiWindow/ui/useProjectScopeGroups";
import { useProjectTintColors } from "../../multiWindow/ui/useProjectTintColors";
import { notifyWindowActionFailure } from "../../multiWindow/ui/windowActions";
import {
  normalizeWindowProfileName,
  WINDOW_PROFILE_NAME_MAX_LENGTH,
} from "../../multiWindow/ui/windowProfiles.logic";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useThemeCards } from "../CommandPaletteThemeItems";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { ThemePreviewCircle, type ThemeCardDefinition } from "./ThemePreviewCircles";

type ProjectScopeGroups = ReturnType<typeof useProjectScopeGroups>;

// The theme's accent, or its projects' colours, washes a window's row this strongly at the right.
const ROW_THEME_WASH_PERCENT = 16;

// Select values cannot be null, so following the main window gets a value no theme id has.
const FOLLOW_MAIN_WINDOW_THEME = ":follow-main-window";
const themeSelectValue = (theme: string | null) => theme ?? FOLLOW_MAIN_WINDOW_THEME;

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
          <div className="overflow-hidden rounded-ee-xl border-s border-border/60 *:not-first:border-t *:not-first:border-border/50 [&>[data-slot=settings-row]]:rounded-none">
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

interface WindowThemeOption {
  readonly value: string;
  readonly label: string;
  /** A theme's light and dark previews; the project colour option has none. */
  readonly previews: ThemeCardDefinition["previews"];
  /** What a window with this theme shows of it: the theme's accent, or its projects' colours. */
  readonly colors: readonly string[];
}

function useWindowThemeOptions(projects: readonly SidebarProjectSnapshot[]): WindowThemeOption[] {
  const themeCards = useThemeCards();
  const appearance = useRenderedAppearance();
  const projectColors = useProjectTintColors(projects);
  return [
    // Without a project filter there is no project colour to take on.
    {
      value: FOLLOW_MAIN_WINDOW_THEME,
      label: projects.length > 0 ? "Project colour" : "Follow main window",
      previews: [],
      colors: projectColors,
    },
    ...themeCards.map((card) => {
      const preview =
        card.previews.find((candidate) => candidate.mode === appearance) ?? card.previews[0];
      return {
        value: card.id ?? "system",
        label: card.label,
        previews: card.previews,
        colors: preview === undefined ? [] : [preview.colors.accent],
      };
    }),
  ];
}

/**
 * The row's wash of its theme's colours, strongest at the right edge and fading to nothing at the
 * left. Several colours keep their left-to-right order, each fainter than the one to its right.
 */
function themeWashStyle(options: readonly WindowThemeOption[], theme: string | null) {
  const colors = options.find((option) => option.value === themeSelectValue(theme))?.colors ?? [];
  if (colors.length === 0) return undefined;
  const stops = colors.toReversed().map((color, index) => {
    const share = index / colors.length;
    return `color-mix(in oklab, ${color} ${ROW_THEME_WASH_PERCENT * (1 - share)}%, transparent) ${share * 100}%`;
  });
  return { backgroundImage: `linear-gradient(to left, ${[...stops, "transparent"].join(", ")})` };
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
  const themeOptions = useWindowThemeOptions(projectGroups.groupsForKeys(profile.projectScopeKeys));
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
      title={
        <>
          <ProfileNameInput bridge={bridge} profile={profile} />
          {profile.isDefault ? (
            <span className="font-normal text-muted-foreground"> (main window)</span>
          ) : null}
        </>
      }
      description={
        profile.isDefault
          ? "Holds the connections and drafts every window shares."
          : projectFilterSummary(projectGroups, profile.projectScopeKeys)
      }
      style={profile.isDefault ? undefined : themeWashStyle(themeOptions, profile.theme)}
      control={
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
          {profile.isDefault ? null : (
            <Label>
              Theme
              <WindowThemeSelect
                options={themeOptions}
                value={profile.theme}
                ariaLabel={`Theme of ${profile.name}`}
                onChange={(theme) => {
                  bridge.updateProfile({ profileId: profile.id, theme }).catch((cause: unknown) => {
                    notifyWindowActionFailure("Couldn't change the window theme", cause);
                  });
                }}
              />
            </Label>
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
  const themeOptions = useWindowThemeOptions(projectGroups.groupsForKeys(projectScopeKeys));
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
      title={
        <WindowNameInput
          aria-label="Name of the new window"
          placeholder="New saved window"
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            create();
          }}
        />
      }
      description="Open it later from here, the command palette or the Window menu."
      style={themeWashStyle(themeOptions, theme)}
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
      <div className="grid gap-3 pt-1 pb-3 sm:grid-cols-2">
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
            options={themeOptions}
            value={theme}
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
            {/* A group's projects, such as an umbrella's members, sit indented under its name. */}
            {group.isScratch
              ? null
              : group.memberProjects
                  // Once per name, leaving out the member the group's own row already names.
                  .filter(
                    (member, index, members) =>
                      member.title !== group.displayName &&
                      members.findIndex((other) => other.title === member.title) === index,
                  )
                  .map((member) => (
                    <span
                      key={member.physicalProjectKey}
                      className="flex min-w-0 items-center gap-2 ps-5 pt-1 text-muted-foreground text-xs"
                    >
                      <ProjectFavicon project={member} className="size-3.5" />
                      <span className="min-w-0 truncate">{member.title}</span>
                    </span>
                  ))}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** A theme's name with swatches of its light and dark colours, or of its projects' colours. */
function ThemeOptionLabel({ option }: { readonly option: WindowThemeOption }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      <span className="flex shrink-0 items-center gap-1" aria-hidden>
        {option.previews.length > 0
          ? option.previews.map((preview) => (
              <ThemePreviewCircle
                key={preview.mode}
                colors={preview.colors}
                mode={preview.mode}
                className="size-3 border-0"
              />
            ))
          : option.colors.map((color) => (
              <span
                key={color}
                className="size-3 rounded-full"
                style={{ backgroundColor: color }}
              />
            ))}
      </span>
    </span>
  );
}

function WindowThemeSelect({
  options,
  value,
  ariaLabel,
  fullWidth = false,
  onChange,
}: {
  readonly options: readonly WindowThemeOption[];
  readonly value: string | null;
  readonly ariaLabel: string;
  readonly fullWidth?: boolean;
  readonly onChange: (theme: string | null) => void;
}) {
  const selectValue = themeSelectValue(value);
  const selected = options.find((option) => option.value === selectValue);
  return (
    <Select
      value={selectValue}
      onValueChange={(next) => {
        if (typeof next !== "string" || next === selectValue) return;
        onChange(next === FOLLOW_MAIN_WINDOW_THEME ? null : next);
      }}
    >
      <SelectTrigger
        size="sm"
        className={fullWidth ? "w-full" : "w-full sm:w-44"}
        aria-label={ariaLabel}
      >
        <SelectValue>{selected ? <ThemeOptionLabel option={selected} /> : value}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem hideIndicator key={option.value} value={option.value}>
            <ThemeOptionLabel option={option} />
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** A window's name, edited in place where it is shown. */
function WindowNameInput(props: ComponentProps<"input">) {
  return (
    <input
      maxLength={WINDOW_PROFILE_NAME_MAX_LENGTH}
      className="-mx-1 field-sizing-content min-w-8 max-w-[60cqi] rounded-sm bg-transparent px-1 font-medium text-foreground outline-none placeholder:text-placeholder hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      {...props}
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
    <WindowNameInput
      aria-label={`Name of ${profile.name}`}
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
