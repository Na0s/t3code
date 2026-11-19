import { useState } from "react";

import type { EnvironmentPullRequestEntry } from "../../components/pullRequest/pullRequestList.logic";
import { readPullRequestListPreferences } from "../../components/pullRequest/pullRequestListPreferences";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowGlyph,
  PullRequestRowLines,
} from "../../components/pullRequest/PullRequestListRow";
import {
  PullRequestReviewDecisionGlyph,
  pullRequestChecksStatePresentation,
} from "../../components/pullRequest/pullRequestPresentation";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { useEnvironments } from "../../state/environments";
import { usePullRequestList } from "../../state/pullRequests";

const MINI_PULL_REQUEST_LIMIT = 20;

/** The PRs tab: the list the Pull requests page would open with, read while the tab is showing. */
export function MiniPullRequests() {
  const { environments } = useEnvironments();
  const [{ state, involvement }] = useState(readPullRequestListPreferences);
  const list = usePullRequestList(
    environments
      .filter((environment) => environment.serverConfig !== null)
      .map(({ environmentId }) => ({
        environmentId,
        input: { state, involvement, limit: MINI_PULL_REQUEST_LIMIT },
      })),
  );
  return (
    <MiniPullRequestList
      entries={list.data?.entries ?? (list.isPending ? null : [])}
      error={list.data === null ? (list.error?.message ?? null) : null}
      onOpen={(url) => void ensureLocalApi().shell.openExternal(url)}
    />
  );
}

export function MiniPullRequestList({
  entries,
  error,
  onOpen,
}: {
  /** Null until a connected environment answers. */
  readonly entries: readonly EnvironmentPullRequestEntry[] | null;
  readonly error: string | null;
  readonly onOpen: (url: string) => void;
}) {
  return (
    <section aria-label="Pull requests" className="p-(--sidebar-content-inset)">
      {entries === null ? (
        <div role="status" aria-label="Loading pull requests" className="flex flex-col gap-2 p-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-28" />
        </div>
      ) : entries.length === 0 ? (
        <p className="px-(--sidebar-row-content-inset) py-2 text-secondary-label text-sm">
          {error ?? "No pull requests match your Pull requests page filter."}
        </p>
      ) : (
        <ul>
          {entries.map((entry) => {
            const checks =
              entry.checksState === undefined
                ? null
                : pullRequestChecksStatePresentation(entry.checksState);
            return (
              <li key={entry.url}>
                <button
                  type="button"
                  className={cn(
                    PULL_REQUEST_ROW_CLASS,
                    "cursor-pointer px-(--sidebar-row-content-inset) py-1.5 outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  )}
                  onClick={() => onOpen(entry.url)}
                >
                  <PullRequestRowGlyph
                    state={entry.state}
                    isDraft={entry.isDraft}
                    mergeability={entry.mergeability}
                    baseBranch={entry.baseBranch}
                    className="mt-0.75 self-start"
                  />
                  <PullRequestRowLines
                    number={<span className={PULL_REQUEST_ROW_NUMBER_CLASS}>#{entry.number}</span>}
                    title={entry.title}
                    signals={
                      <>
                        {checks === null ? null : (
                          <checks.Icon
                            aria-label={checks.label}
                            className={cn("size-3.5", checks.toneClassName)}
                          />
                        )}
                        {entry.reviewDecision === undefined ? null : (
                          <PullRequestReviewDecisionGlyph decision={entry.reviewDecision} />
                        )}
                      </>
                    }
                    meta={<span className="min-w-0 truncate">{entry.repository}</span>}
                    updatedAt={entry.updatedAt}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
