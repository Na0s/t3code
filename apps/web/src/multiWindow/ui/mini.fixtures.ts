import {
  type DesktopOpenWindow,
  type DesktopUpdateState,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  SourceControlProviderKind,
} from "@t3tools/contracts";

import type { EnvironmentPullRequestEntry } from "../../components/pullRequest/pullRequestList.logic";
import type { MiniUsagePresentations } from "./miniUsage.logic";
import type { MiniWindowProject } from "./MiniWindows";

export const FIXTURE_NOW = Date.parse("2026-10-25T16:00:00.000Z");
const HOUR = 3_600_000;

const iso = (offsetMs: number) => new Date(FIXTURE_NOW + offsetMs).toISOString();

export function usageWindow(
  id: string,
  kind: ServerProviderUsageWindow["kind"],
  label: string,
  usedPercent: number,
  resetsInHours: number,
  durationHours: number,
): ServerProviderUsageWindow {
  return {
    id,
    kind,
    label,
    usedPercent,
    resetsAt: iso(resetsInHours * HOUR),
    windowDurationMins: durationHours * 60,
  };
}

export function provider(
  driver: string,
  usageLimits: Partial<ServerProviderUsageLimits> | undefined,
  options: { readonly plan?: string; readonly email?: string; readonly name?: string } = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(options.name ? `${driver}_${options.name}` : driver),
    driver: ProviderDriverKind.make(driver),
    ...(options.name ? { displayName: options.name } : {}),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: {
      status: "authenticated",
      ...(options.plan ? { label: options.plan } : {}),
      ...(options.email ? { email: options.email } : {}),
    },
    checkedAt: iso(-4 * 60_000),
    models: [],
    slashCommands: [],
    skills: [],
    ...(usageLimits
      ? { usageLimits: { checkedAt: iso(-4 * 60_000), windows: [], ...usageLimits } }
      : {}),
  };
}

export function presentations(
  providers: readonly ServerProvider[] | null,
  phase = "connected",
  label = "Desk",
): MiniUsagePresentations {
  return new Map([
    [
      EnvironmentId.make(label.toLowerCase()),
      {
        entry: { target: { label } },
        connection: { phase },
        serverConfig: providers === null ? null : { providers },
      },
    ],
  ]);
}

export const CLAUDE = provider(
  "claudeAgent",
  {
    windows: [
      usageWindow("five_hour", "session", "Session", 38, 2.25, 5),
      usageWindow("seven_day", "weekly", "Weekly", 59, 76, 168),
    ],
  },
  { plan: "Max" },
);

export const CODEX = provider(
  "codex",
  {
    windows: [
      usageWindow("primary", "session", "Session", 94, 0.7, 5),
      usageWindow("secondary", "weekly", "Weekly", 22, 120, 168),
    ],
  },
  { plan: "ChatGPT Pro 100 Subscription" },
);

export const CLAUDE_UNREADABLE = provider(
  "claudeAgent",
  { unavailable: { reason: "probeFailed", message: "Could not read limits. Sign in again." } },
  { name: "Claude" },
);

export function openWindow(
  windowId: number,
  name: string,
  title: string,
  overrides: Partial<DesktopOpenWindow> = {},
): DesktopOpenWindow {
  return {
    windowId,
    isMain: false,
    profileId: name,
    name,
    title,
    focused: false,
    projectScopeKeys: [],
    ...overrides,
  };
}

function windowProject(
  displayName: string,
  text: string,
  color: "orange" | "pink" | "sky",
): MiniWindowProject {
  return {
    projectKey: displayName,
    displayName,
    environmentId: EnvironmentId.make("desk"),
    workspaceRoot: `/work/${displayName}`,
    title: displayName,
    faviconPath: null,
    projectIcon: { kind: "monogram", text, color },
  };
}

const WINDOW_PROJECTS = [
  windowProject("Northwind", "NW", "orange"),
  windowProject("Dungeon", "DG", "pink"),
  windowProject("Synth", "SY", "sky"),
];

export const projectsFor = (keys: readonly string[]) =>
  WINDOW_PROJECTS.filter((project) => keys.includes(project.projectKey));

function pullRequest(
  number: number,
  title: string,
  overrides: Partial<EnvironmentPullRequestEntry> = {},
): EnvironmentPullRequestEntry {
  return {
    environmentId: EnvironmentId.make("desk"),
    provider: SourceControlProviderKind.make("github"),
    host: "github.com",
    projectId: ProjectId.make("northwind"),
    projectTitle: "Northwind",
    repository: "acme/northwind",
    number,
    title,
    url: `https://github.com/acme/northwind/pull/${number}`,
    author: null,
    headBranch: `feature-${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 0,
    deletions: 0,
    createdAt: iso(-30 * HOUR),
    updatedAt: iso(-2 * HOUR),
    viewerReviewRequested: false,
    labels: [],
    ...overrides,
  };
}

export const PULL_REQUESTS = [
  pullRequest(482, "Rate limit the checkout webhook", {
    checksState: "passing",
    reviewDecision: "approved",
  }),
  pullRequest(479, "Dungeon lighting: fix flicker on integrated GPUs", {
    repository: "acme/dungeon",
    checksState: "failing",
    reviewDecision: "changes-requested",
    updatedAt: iso(-5 * HOUR),
  }),
  pullRequest(31, "Filter envelope presets", {
    repository: "acme/synth",
    isDraft: true,
    checksState: "pending",
    updatedAt: iso(-26 * HOUR),
  }),
];

export const UPDATE_AVAILABLE: DesktopUpdateState = {
  enabled: true,
  status: "available",
  channel: "latest",
  currentVersion: "0.0.50",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: "0.0.51",
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};
