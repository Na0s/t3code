import {
  type DesktopOpenWindow,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";

import type { MiniUsagePresentations } from "./miniUsage.logic";

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
  return { windowId, isMain: false, profileId: name, name, title, focused: false, ...overrides };
}
