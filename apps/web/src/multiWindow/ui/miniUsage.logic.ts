import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import {
  collectExternalUsageLinks,
  collectLimitAccounts,
  collectLimitNotices,
  collectLimitPools,
  cursorUsageWindowDetails,
  displayLimitWindows,
  formatDuration,
  formatResetsIn,
  type LimitPace,
  type LimitPool,
  type LimitPoolWindow,
  type LimitPresentations,
  paceRemainingPercent,
} from "@t3tools/shared/usageLimits";

/** At or below this share left, a limit is called out. */
const MINI_USAGE_LOW_PERCENT = 10;

type LimitPresentation =
  LimitPresentations extends ReadonlyMap<EnvironmentId, infer Presentation> ? Presentation : never;

export type MiniUsagePresentations = ReadonlyMap<
  EnvironmentId,
  LimitPresentation & { readonly connection: { readonly phase: string } }
>;

/** Drops the providers the Usage page hides, as its limits view does. */
export function withoutHiddenProviders(
  presentations: MiniUsagePresentations,
  hiddenDrivers: ReadonlySet<ServerProvider["driver"]>,
): MiniUsagePresentations {
  if (hiddenDrivers.size === 0) return presentations;
  return new Map(
    [...presentations].map(([id, presentation]) => {
      const config = presentation.serverConfig;
      if (config === null) return [id, presentation] as const;
      const serverConfig = {
        ...config,
        providers: config.providers.filter((provider) => !hiddenDrivers.has(provider.driver)),
        usageLimitSources: config.usageLimitSources?.flatMap((source) => {
          const accounts = source.accounts.filter((account) => !hiddenDrivers.has(account.driver));
          return accounts.length === 0 && source.accounts.length > 0
            ? []
            : [{ ...source, accounts }];
        }),
      };
      return [id, { ...presentation, serverConfig }] as const;
    }),
  );
}

export interface MiniUsageWindow {
  readonly key: string;
  readonly label: string;
  readonly remainingPercent: number;
  readonly tone: "normal" | "low" | "out";
  readonly pace: LimitPace | null;
  /** Where even spending would be; null when the window has no clock or pools several accounts. */
  readonly evenPacePercent: number | null;
  readonly reset: string | null;
}

export interface MiniUsageProvider {
  readonly driver: ServerProvider["driver"];
  /** The plan when every account shares one, else the account count. */
  readonly detail: string | null;
  readonly accentColor: string | undefined;
  readonly windows: readonly MiniUsageWindow[];
}

export type MiniUsage =
  | { readonly status: "loading" }
  | { readonly status: "empty" }
  | {
      readonly status: "ready";
      readonly providers: readonly MiniUsageProvider[];
      readonly links: ReturnType<typeof collectExternalUsageLinks>;
      readonly notices: readonly string[];
      /** The oldest reading on screen, so the age shown never flatters the data. */
      readonly checkedAt: number | null;
    };

function windowReset(window: LimitPoolWindow, now: number): string | null {
  const [only] = window.members;
  if (window.members.length === 1 && only) return formatResetsIn(only.window, now);
  const next = window.resets.find((reset) => reset.at > now && reset.restoresPercent > 0);
  return next ? `+${next.restoresPercent}% in ${formatDuration(next.at - now)}` : null;
}

function miniWindow(pool: LimitPool, window: LimitPoolWindow, now: number): MiniUsageWindow {
  const [only] = window.members;
  const details = pool.driver === "cursor" ? cursorUsageWindowDetails(window.id, pool) : undefined;
  return {
    key: `${window.kind}:${window.id}`,
    label: details?.label ?? window.label,
    remainingPercent: window.remainingPercent,
    tone:
      window.remainingPercent <= 0
        ? "out"
        : window.remainingPercent <= MINI_USAGE_LOW_PERCENT
          ? "low"
          : "normal",
    pace: window.pace,
    evenPacePercent:
      window.members.length === 1 && only ? paceRemainingPercent(only.window, now) : null,
    reset: windowReset(window, now),
  };
}

function providerDetail(pool: LimitPool): string | null {
  if (pool.accounts.length > 1) return `${pool.accounts.length} accounts`;
  return pool.accounts[0]?.plan?.replace(/ subscription$/i, "") ?? null;
}

export function deriveMiniUsage(presentations: MiniUsagePresentations, now: number): MiniUsage {
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  const links = collectExternalUsageLinks(presentations);
  const pending = [...presentations.values()].filter(
    (presentation) => presentation.serverConfig === null,
  );
  const connecting = pending.filter((presentation) =>
    ["connecting", "reconnecting"].includes(presentation.connection.phase),
  );
  const notices = [
    ...collectLimitNotices(presentations),
    ...pending
      .filter((presentation) => !connecting.includes(presentation))
      .map((presentation) => `${presentation.entry.target.label}: Not connected.`),
  ];
  const providers = pools.flatMap((pool) => {
    const windows = displayLimitWindows(pool).map((window) => miniWindow(pool, window, now));
    return windows.length === 0
      ? []
      : [
          {
            driver: pool.driver,
            detail: providerDetail(pool),
            accentColor: pool.accounts.length === 1 ? pool.accounts[0]?.accentColor : undefined,
            windows,
          },
        ];
  });
  if (providers.length === 0 && links.length === 0 && notices.length === 0) {
    return presentations.size === 0 || connecting.length > 0
      ? { status: "loading" }
      : { status: "empty" };
  }
  const checked = pools
    .flatMap((pool) => pool.accounts.map((account) => Date.parse(account.limits.checkedAt)))
    .filter(Number.isFinite);
  return {
    status: "ready",
    providers,
    links,
    notices,
    checkedAt: checked.length === 0 ? null : Math.min(...checked),
  };
}

export function formatCheckedAgo(checkedAt: number, now: number): string {
  const age = now - checkedAt;
  return age < 60_000 ? "Updated just now" : `Updated ${formatDuration(age)} ago`;
}
