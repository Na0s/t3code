import { useAtomValue } from "@effect/atom-react";
import { AuthSettingsWriteScope, repositoryGroupingDisplayNameOf } from "@t3tools/contracts";
import { umbrellaMemberLabel } from "@t3tools/client-runtime/state/umbrella";
import { UmbrellaIcon } from "lucide-react";
import { Fragment, useState } from "react";

import { useUmbrellaMembershipEdits } from "../../hooks/useUmbrellaMembershipEdits";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentsWithScope } from "../../state/session";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { applyPendingScopedWrites, pendingScopedWritesAtom } from "./scopedSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const isAbsolutePath = (value: string) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);

function UmbrellaAdoptForm(props: {
  disabled: boolean;
  environmentLabel: string;
  onAdopt: (path: string) => void;
}) {
  const [path, setPath] = useState("");
  return (
    <form
      className="flex w-full min-w-0 items-center gap-2 sm:w-auto"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = path.trim();
        if (!isAbsolutePath(trimmed)) {
          toastManager.add({
            type: "warning",
            title: "Checkout not added",
            description: `Enter an absolute path on ${props.environmentLabel}.`,
          });
          return;
        }
        props.onAdopt(trimmed);
        setPath("");
      }}
    >
      <Input
        size="sm"
        className="min-w-0 flex-1 sm:w-64 sm:flex-none"
        aria-label="Checkout path"
        placeholder="/path/to/checkout"
        disabled={props.disabled}
        value={path}
        onChange={(event) => setPath(event.target.value)}
      />
      <Button size="sm" variant="outline" type="submit" disabled={props.disabled || !path.trim()}>
        Add
      </Button>
    </form>
  );
}

/** Each project in the group that can hold checkouts, with its umbrella state and writability. */
function useUmbrellaProjects(group: SidebarProjectSnapshot) {
  const { environments } = useEnvironments();
  const pendingWrites = useAtomValue(pendingScopedWritesAtom);
  const shownEnvironments = applyPendingScopedWrites(environments, pendingWrites);
  const umbrellas = group.memberProjects.filter(
    (project) =>
      !project.isScratch &&
      !group.foldedUmbrellaMembers.has(`${project.environmentId}:${project.id}`),
  );
  const writableIds = useEnvironmentsWithScope(umbrellas, AuthSettingsWriteScope);
  return umbrellas.map((project) => {
    const environment = shownEnvironments.find(
      (candidate) => candidate.environmentId === project.environmentId,
    );
    const overrides = environment?.serverConfig?.settings.projectSettingsOverrides[project.id];
    return {
      project,
      environmentLabel: project.environmentLabel ?? environment?.label ?? "this environment",
      enabled: overrides?.umbrellaEnabled === true,
      excluded: overrides?.umbrellaExcludedPaths ?? [],
      suggestions: project.umbrellaSuggestions ?? [],
      disabled:
        !writableIds.has(project.environmentId) ||
        environment?.connection.phase !== "connected" ||
        !environment.serverConfig,
    };
  });
}

/** Offers the umbrella at the top of a project's settings when its folder holds checkouts. */
export function ProjectUmbrellaPrompt({ group }: { group: SidebarProjectSnapshot }) {
  const edits = useUmbrellaMembershipEdits();
  const candidate = useUmbrellaProjects(group).find(
    (entry) =>
      !entry.enabled &&
      !entry.disabled &&
      entry.suggestions.length > 0 &&
      entry.project.umbrellaEnclosingRepository === undefined,
  );
  if (candidate === undefined) return null;
  const { project, suggestions } = candidate;
  return (
    <Alert variant="info">
      <UmbrellaIcon aria-hidden />
      <AlertTitle>
        {suggestions.length === 1 ? "1 project" : `${suggestions.length} projects`} detected within
        this folder: {suggestions.map(umbrellaMemberLabel).join(", ")}.
      </AlertTitle>
      <AlertDescription>Use {group.displayName} as umbrella project?</AlertDescription>
      <AlertAction>
        <Button size="sm" onClick={() => void edits.confirmEnable(project)}>
          Use as umbrella
        </Button>
      </AlertAction>
    </Alert>
  );
}

/** Members, exclusions, and adoption for each project in the group that can hold checkouts. */
export function ProjectUmbrellaSettings({ group }: { group: SidebarProjectSnapshot }) {
  const edits = useUmbrellaMembershipEdits();
  const umbrellas = useUmbrellaProjects(group);
  if (umbrellas.length === 0) return null;

  const rowsFor = ({
    project,
    environmentLabel,
    enabled,
    excluded,
    suggestions,
    disabled,
  }: (typeof umbrellas)[number]) => {
    const prefix = umbrellas.length > 1 ? `${environmentLabel} · ` : "";
    if (project.umbrellaEnclosingRepository !== undefined) {
      return (
        <SettingsRow
          key={`${project.environmentId}:${project.id}`}
          title={`${prefix}Use as umbrella`}
          description={`Unavailable: this folder is inside the repository at ${project.umbrellaEnclosingRepository}. Use that repository's root, or a folder outside any repository, as the umbrella.`}
        />
      );
    }
    return (
      <Fragment key={`${project.environmentId}:${project.id}`}>
        <SettingsRow
          title={`${prefix}Use as umbrella`}
          description={
            enabled
              ? "Turns record checkpoints in the checkouts below, and reverting a turn restores them."
              : suggestions.length > 0
                ? `Found ${suggestions.length === 1 ? "1 checkout" : `${suggestions.length} checkouts`} in this folder, listed below. Turning this on lets turns checkpoint and restore them.`
                : "No checkouts found in this folder. Add one below to start an umbrella."
          }
          control={
            <Switch
              checked={enabled}
              disabled={disabled || (!enabled && suggestions.length === 0)}
              aria-label="Use as umbrella"
              onCheckedChange={(checked) => {
                if (checked) void edits.confirmEnable(project);
                else edits.setEnabled(project, false);
              }}
            />
          }
        />
        {!enabled
          ? suggestions.map((suggestion) => (
              <SettingsRow
                key={`suggested:${suggestion.path}`}
                title={`${prefix}${suggestion.relativePath}`}
                description="Found in this folder. Joins when the umbrella is on."
              />
            ))
          : null}
        {project.umbrellaMembers === undefined ? (
          <SettingsRow
            title={`${prefix}Checkouts`}
            description="This folder has not been scanned for checkouts yet."
          />
        ) : null}
        {project.umbrellaMembers?.map((member) => {
          const repository = member.repositoryIdentity
            ? (repositoryGroupingDisplayNameOf(member.repositoryIdentity) ??
              member.repositoryIdentity.name)
            : null;
          return (
            <SettingsRow
              key={member.path}
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{`${prefix}${member.relativePath}`}</span>
                  <Badge variant="outline" size="sm">
                    {member.source === "nested" ? "Found in folder" : "Added"}
                  </Badge>
                </span>
              }
              description={repository ?? member.path}
              control={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  aria-label={`Remove ${member.relativePath} from the umbrella`}
                  onClick={() => edits.remove(project, member)}
                >
                  Remove
                </Button>
              }
            />
          );
        })}
        {excluded.map((path) => (
          <SettingsRow
            key={`excluded:${path}`}
            title={`${prefix}${path}`}
            description="Left out of this umbrella."
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                aria-label={`Restore ${path} to the umbrella`}
                onClick={() => edits.restore(project, path)}
              >
                Restore
              </Button>
            }
          />
        ))}
        <SettingsRow
          title={`${prefix}Add checkout`}
          description={`A git checkout anywhere on ${environmentLabel}, by absolute path.`}
          control={
            <UmbrellaAdoptForm
              disabled={disabled}
              environmentLabel={environmentLabel}
              onAdopt={(path) => edits.adopt(project, path)}
            />
          }
        />
      </Fragment>
    );
  };

  return (
    <SettingsSection id="project-umbrella" title="Umbrella checkouts">
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        Git checkouts this project spans once it is an umbrella. Their projects' threads group under
        it, and the diff panel shows each checkout's changes.
      </p>
      {umbrellas.map(rowsFor)}
    </SettingsSection>
  );
}
