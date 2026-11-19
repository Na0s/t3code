import { useAtomValue } from "@effect/atom-react";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { providerClients } from "../../components/settings/providerDriverMeta";
import { Button } from "../../components/ui/button";
import { RefreshIcon } from "../../components/ui/refresh-icon";
import { Skeleton } from "../../components/ui/skeleton";
import { barColor, PaceIcon, usePaceMark } from "../../components/usage/UsageLimits";
import { readUsagePagePreferences } from "../../components/usage/usagePagePreferences";
import { PROVIDER_PRESENTATION } from "../../components/usage/usageProviders";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  deriveMiniUsage,
  formatCheckedAgo,
  type MiniUsage as MiniUsageData,
  type MiniUsageProvider,
  type MiniUsageWindow,
  withoutHiddenProviders,
} from "./miniUsage.logic";

const CLOCK_TICK_MS = 60_000;

const TONE_CLASS: Record<MiniUsageWindow["tone"], string> = {
  normal: "text-foreground",
  low: "text-warning-foreground",
  out: "text-destructive-foreground",
};

function MiniLimitBar({
  color,
  window,
}: {
  readonly color: string;
  readonly window: MiniUsageWindow;
}) {
  const [barRef, paceMark] = usePaceMark(window.evenPacePercent);
  return (
    <div ref={barRef} aria-hidden className="relative h-2.5">
      <div className="absolute inset-0" style={paceMark?.gap}>
        <div className="absolute inset-x-0 inset-y-0.5 rounded-full bg-muted-foreground/20" />
        {window.remainingPercent > 0 ? (
          <div
            className="absolute inset-y-0.5 left-0 rounded-full"
            style={{ width: `${window.remainingPercent}%`, backgroundColor: color }}
          />
        ) : null}
      </div>
      {paceMark ? (
        <span
          className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
          style={paceMark.tick}
        />
      ) : null}
    </div>
  );
}

function MiniLimitWindow({
  color,
  window,
}: {
  readonly color: string;
  readonly window: MiniUsageWindow;
}) {
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex h-4 min-w-0 items-center gap-1.5 text-xs">
        <span className="min-w-0 truncate text-muted-foreground">{window.label}</span>
        {/* Only overspending is worth a mark here; the bar's tick carries the rest. */}
        {window.pace === "ahead" ? <PaceIcon pace={window.pace} /> : null}
        <span className="ms-auto shrink-0 whitespace-nowrap text-2xs text-muted-foreground tabular-nums">
          {window.reset}
        </span>
        <span
          className={cn(
            "w-16 shrink-0 text-end font-semibold whitespace-nowrap tabular-nums",
            TONE_CLASS[window.tone],
          )}
        >
          {window.remainingPercent}% left
        </span>
      </div>
      <MiniLimitBar color={color} window={window} />
    </li>
  );
}

function MiniProvider({ provider }: { readonly provider: MiniUsageProvider }) {
  const label = providerClients.get(provider.driver)?.label ?? String(provider.driver);
  const color = normalizeProviderAccentColor(provider.accentColor) ?? barColor(provider.driver);
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <ProviderInstanceIcon
          driverKind={provider.driver}
          displayName={label}
          indicatorBackground="var(--background)"
          className="size-4"
          iconClassName="size-3.5 text-foreground/80"
        />
        <h3 className="min-w-0 truncate font-medium text-foreground text-sm">{label}</h3>
        {provider.detail ? (
          <span className="ms-auto max-w-1/2 shrink-0 truncate text-2xs text-muted-foreground">
            {provider.detail}
          </span>
        ) : null}
      </div>
      <ul className="flex flex-col gap-1.5">
        {provider.windows.map((window) => (
          <MiniLimitWindow key={window.key} color={color} window={window} />
        ))}
      </ul>
    </li>
  );
}

function MiniUsageSkeleton() {
  return (
    <div role="status" aria-label="Loading usage limits" className="flex flex-col gap-4 pt-1">
      {[0, 1].map((provider) => (
        <div key={provider} className="flex flex-col gap-2.5">
          <Skeleton className="h-4 w-24" />
          {[0, 1].map((window) => (
            <div key={window} className="flex flex-col gap-1.5">
              <div className="flex justify-between">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-12" />
              </div>
              <Skeleton shape="pill" className="h-1.5 w-full" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The Usage tab: rereads the limits while it is showing and keeps their clock current. */
export function MiniUsage() {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [hiddenDrivers] = useState(
    () =>
      new Set(
        (readUsagePagePreferences().hiddenProviders ?? []).map(
          (provider) => PROVIDER_PRESENTATION[provider].driverKind,
        ),
      ),
  );

  const refreshLimits = (automatic: boolean) =>
    Promise.allSettled(
      Array.from(presentations, ([environmentId, presentation]) =>
        presentation.connection.phase === "connected" && presentation.serverConfig !== null
          ? refreshUsageLimits(
              environmentId,
              () => refreshProviders({ environmentId, input: {} }),
              automatic,
            )
          : undefined,
      ),
    ).then(() => setNow(Date.now()));
  const autoRefresh = useEffectEvent(() => {
    void refreshLimits(true);
  });
  const wake = useEffectEvent(() => {
    setNow(Date.now());
    autoRefresh();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the wall clock once a minute while visible, and when the window regains focus
  useEffect(() => {
    const tick = setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, CLOCK_TICK_MS);
    globalThis.window.addEventListener("focus", wake);
    return () => {
      clearInterval(tick);
      globalThis.window.removeEventListener("focus", wake);
    };
  }, []);
  const connectedEnvironments = [...presentations]
    .filter(
      ([, presentation]) =>
        presentation.connection.phase === "connected" && presentation.serverConfig !== null,
    )
    .map(([environmentId]) => environmentId)
    .sort()
    .join(",");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- rereads provider limits from the server when the tab opens or the connected environment set changes
  useEffect(() => {
    if (connectedEnvironments) autoRefresh();
  }, [connectedEnvironments]);

  return (
    <MiniUsageSection
      usage={deriveMiniUsage(withoutHiddenProviders(presentations, hiddenDrivers), now)}
      now={now}
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true);
        void refreshLimits(false).then(() => setRefreshing(false));
      }}
      onOpenExternal={(url) => void ensureLocalApi().shell.openExternal(url)}
    />
  );
}

/** What is left of each provider's plan, and when it comes back. */
export function MiniUsageSection({
  usage,
  now,
  refreshing,
  onRefresh,
  onOpenExternal,
}: {
  readonly usage: MiniUsageData;
  readonly now: number;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly onOpenExternal: (url: string) => void;
}) {
  const checkedAt = usage.status === "ready" ? usage.checkedAt : null;
  return (
    <section aria-labelledby="mini-mode-usage" className="flex flex-col gap-2 px-4.5 pb-3">
      <div className="flex h-6 items-center gap-2">
        <h2 id="mini-mode-usage" className="font-medium text-muted-foreground text-xs">
          Usage
        </h2>
        <span className="ms-auto truncate text-2xs text-muted-foreground tabular-nums">
          {checkedAt === null ? null : formatCheckedAgo(checkedAt, now)}
        </span>
        <Button
          aria-label="Refresh limits"
          aria-busy={refreshing}
          disabled={refreshing}
          size="icon-xs"
          variant="ghost"
          onClick={onRefresh}
        >
          <RefreshIcon refreshing={refreshing} />
        </Button>
      </div>
      {usage.status === "loading" ? <MiniUsageSkeleton /> : null}
      {usage.status === "empty" ? (
        <p className="text-muted-foreground text-xs">
          No provider reports plan limits yet. Limits appear here once a signed-in provider shares
          them.
        </p>
      ) : null}
      {usage.status === "ready" ? (
        <>
          {usage.providers.length > 0 ? (
            <ul className="flex flex-col gap-3.5">
              {usage.providers.map((provider) => (
                <MiniProvider key={provider.driver} provider={provider} />
              ))}
            </ul>
          ) : (
            <p className="font-medium text-foreground text-sm">Limits unavailable</p>
          )}
          {usage.links.map((link) => (
            <div key={link.url} className="flex min-w-0 items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{link.label}</span>
              <Button size="compact" variant="ghost-muted" onClick={() => onOpenExternal(link.url)}>
                Manage usage
                <ExternalLinkIcon aria-hidden />
              </Button>
            </div>
          ))}
          {usage.notices.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {usage.notices.map((notice) => (
                <li key={notice} className="flex min-w-0 gap-1.5 text-muted-foreground text-xs">
                  <TriangleAlertIcon
                    aria-hidden
                    className="mt-0.5 size-3 shrink-0 text-warning-foreground"
                  />
                  <span className="min-w-0 break-words">{notice}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
