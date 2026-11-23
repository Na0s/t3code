import { useAtomValue } from "@effect/atom-react";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { collectLimitAccounts, type LimitPresentations } from "@t3tools/shared/usageLimits";
import { collectExternalUsageLinks, collectLimitNotices } from "@t3tools/shared/usageLimitsCopy";
import { T, useGT, useMessages } from "gt-react";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { providerClients } from "../../components/settings/providerDriverMeta";
import { Button } from "../../components/ui/button";
import { LimitMeters } from "../../components/usage/UsageLimits";
import { ensureLocalApi } from "../../localApi";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/** The Usage tab: rereads stale limits when it opens or an environment connects. */
export function MiniUsage() {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [now, setNow] = useState(() => Date.now());
  const connected = [...presentations]
    .filter(([, { connection, serverConfig }]) => connection.phase === "connected" && serverConfig)
    .map(([environmentId]) => environmentId);
  const refreshLimits = useEffectEvent(() => {
    void Promise.allSettled(
      connected.map((environmentId) =>
        refreshUsageLimits(
          environmentId,
          () => refreshProviders({ environmentId, input: {} }),
          true,
        ),
      ),
    ).then(() => setNow(Date.now()));
  });
  const connectedKey = connected.toSorted().join(",");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- rereads provider limits from the server when the tab opens or the connected environment set changes
  useEffect(() => {
    if (connectedKey) refreshLimits();
  }, [connectedKey]);

  return <MiniUsageSection presentations={presentations} now={now} />;
}

/** Every signed-in account's limits as small meters, so Claude and OpenAI fit the panel together. */
export function MiniUsageSection({
  presentations,
  now,
}: {
  readonly presentations: LimitPresentations;
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const accounts = collectLimitAccounts(presentations);
  return (
    <section
      aria-label={gt("Usage", { $context: "Mini Mode tab showing usage limits" })}
      className="flex flex-col gap-2 p-(--sidebar-content-inset)"
    >
      {accounts.length === 0 ? (
        <p className="font-medium text-sm">
          <T>Usage unavailable</T>
        </p>
      ) : null}
      {accounts.map((account) => (
        <div key={account.key} className="flex flex-col gap-0.5">
          <h3 className="truncate font-medium text-xs">
            {account.displayName ?? providerClients.get(account.driver)?.label ?? account.driver}
            {account.plan ? ` · ${account.plan}` : null}
          </h3>
          <LimitMeters
            driver={account.driver}
            accentColor={account.accentColor}
            windows={account.limits.windows}
            now={now}
          />
        </div>
      ))}
      {collectExternalUsageLinks(presentations, m).map((link) => (
        <Button
          key={link.url}
          size="compact"
          variant="ghost-muted"
          className="self-start"
          onClick={() => void ensureLocalApi().shell.openExternal(link.url)}
        >
          {link.label}
          <ExternalLinkIcon aria-hidden />
        </Button>
      ))}
      {collectLimitNotices(presentations, m).map((notice) => (
        <p key={notice} className="text-muted-foreground text-xs">
          {notice}
        </p>
      ))}
    </section>
  );
}
