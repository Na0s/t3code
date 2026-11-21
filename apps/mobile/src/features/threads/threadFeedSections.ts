import { RunId } from "@t3tools/contracts";
import {
  deriveBotSectionSpans,
  formatBotSectionLabel,
  parseBotSectionMarkers,
  type BotSectionMessageMarkers,
} from "@t3tools/shared/botSections";

import type { ThreadFeedEntry } from "../../lib/threadActivity";

type ThreadFeedMessage = Extract<ThreadFeedEntry, { type: "message" }>["message"];
type RunFoldRow = Extract<ThreadFeedEntry, { type: "run-fold" }>;

export interface ThreadFeedSectionFold {
  /** Toggled-from-default key in the expanded run set; open and closed sections use separate keys. */
  readonly key: RunId;
  readonly label: string;
  readonly createdAt: string;
  readonly expandedByDefault: boolean;
}

const markersByMessage = new WeakMap<ThreadFeedMessage, BotSectionMessageMarkers | null>();

function entryMarkers(entry: ThreadFeedEntry): BotSectionMessageMarkers | null {
  if (entry.type !== "message" || entry.message.role !== "assistant") return null;
  let markers = markersByMessage.get(entry.message);
  if (markers === undefined) {
    markers = parseBotSectionMarkers(entry.message.text);
    markersByMessage.set(entry.message, markers);
  }
  return markers;
}

function startsTurn(entry: ThreadFeedEntry): boolean {
  if (entry.type === "message") {
    return (
      entry.message.role === "user" &&
      entry.message.inputIntent !== "steer" &&
      entry.message.inputIntent !== "promoted_queued_to_steer"
    );
  }
  return (
    entry.type === "activity-group" &&
    entry.activities.some((activity) => activity.projectedItem.item.type === "notification")
  );
}

/** Bot section folds by member entry id, from the unfiltered feed so zen cannot drop a marker. */
export function threadFeedSectionFolds(
  feed: ReadonlyArray<ThreadFeedEntry>,
  isWorking: boolean,
): ReadonlyMap<string, ThreadFeedSectionFold> {
  const byEntryId = new Map<string, ThreadFeedSectionFold>();
  const spans = deriveBotSectionSpans(feed, { markers: entryMarkers, startsTurn });
  if (spans.length === 0) return byEntryId;
  const activeTurnStart = isWorking ? feed.findLastIndex(startsTurn) : feed.length;
  for (const span of spans) {
    // A section ended inside the running turn stays open until that turn settles.
    const open = !span.closed || span.endIndex >= activeTurnStart;
    const startEntry = feed[span.startIndex]!;
    const fold: ThreadFeedSectionFold = {
      key: RunId.make(`${open ? "section-open" : "section"}:${feed[span.markerIndex]!.id}`),
      label: formatBotSectionLabel(span.marker, startEntry.createdAt),
      createdAt: startEntry.createdAt,
      expandedByDefault: open,
    };
    for (let index = span.startIndex; index <= span.endIndex; index += 1) {
      byEntryId.set(feed[index]!.id, fold);
    }
  }
  return byEntryId;
}

export function threadFeedSectionExpanded(
  fold: ThreadFeedSectionFold,
  expandedRunIds: ReadonlySet<RunId>,
): boolean {
  return fold.expandedByDefault !== expandedRunIds.has(fold.key);
}

/**
 * Folds presented rows under their section's run-fold row. Rows the
 * presentation derived (folds, toggles, split groups) belong to the entry
 * row above them; the live thinking row always stays visible.
 */
export function foldThreadFeedSections(
  rows: ReadonlyArray<ThreadFeedEntry>,
  feed: ReadonlyArray<ThreadFeedEntry>,
  folds: ReadonlyMap<string, ThreadFeedSectionFold>,
  expandedRunIds: ReadonlySet<RunId>,
  foldRows: Map<RunId, RunFoldRow>,
): ReadonlyArray<ThreadFeedEntry> {
  if (folds.size === 0) return rows;
  const feedIds = new Set(feed.map((entry) => entry.id));
  const emitted = new Set<RunId>();
  const result: ThreadFeedEntry[] = [];
  let current: ThreadFeedSectionFold | undefined;
  for (const row of rows) {
    if (row.type === "thinking") {
      result.push(row);
      continue;
    }
    if (folds.has(row.id)) current = folds.get(row.id);
    else if (feedIds.has(row.id)) current = undefined;
    if (current === undefined) {
      result.push(row);
      continue;
    }
    const expanded = threadFeedSectionExpanded(current, expandedRunIds);
    if (!emitted.has(current.key)) {
      emitted.add(current.key);
      let foldRow = foldRows.get(current.key);
      if (
        foldRow === undefined ||
        foldRow.label !== current.label ||
        foldRow.createdAt !== current.createdAt ||
        foldRow.expanded !== expanded
      ) {
        foldRow = {
          type: "run-fold",
          id: `run-fold:${current.key}`,
          createdAt: current.createdAt,
          runId: current.key,
          label: current.label,
          expanded,
        };
        foldRows.set(current.key, foldRow);
      }
      result.push(foldRow);
    }
    if (expanded) result.push(row);
  }
  return result;
}
