/**
 * T3_BOT section markers fold a whole exchange under one timeline row:
 * `<!-- t3bot:section kind="status-check" label="Optional title" -->` opens one
 * at the turn that carries it; `<!-- t3bot:section-end -->` closes it.
 */
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export interface BotSectionMarker {
  /** Kebab-case section kind, such as `status-check`. */
  readonly kind: string;
  readonly label: string | null;
}

export interface BotSectionMessageMarkers {
  /** The last section opened by the message, if any. */
  readonly start: BotSectionMarker | null;
  /** Whether the message closes its section; an end before its own start only ends the previous one. */
  readonly end: boolean;
}

export interface BotSectionSpan {
  readonly marker: BotSectionMarker;
  /** Index of the item carrying the opening marker. */
  readonly markerIndex: number;
  readonly startIndex: number;
  /** Inclusive. */
  readonly endIndex: number;
  /** False only for a final section with no end marker. */
  readonly closed: boolean;
}

const MARKER_PREFIX = "t3bot:section";
const MARKER = /<!--\s*t3bot:section(-end)?((?:\s+[a-z]+="[^"]*")*)\s*-->/g;
const ATTRIBUTE = /([a-z]+)="([^"]*)"/g;
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseBotSectionMarkers(text: string): BotSectionMessageMarkers | null {
  if (!text.includes(MARKER_PREFIX)) return null;
  let start: BotSectionMarker | null = null;
  let end = false;
  for (const match of text.matchAll(MARKER)) {
    if (match[1] !== undefined) {
      end = true;
      continue;
    }
    let kind: string | null = null;
    let label: string | null = null;
    for (const [, name, value] of match[2]!.matchAll(ATTRIBUTE)) {
      if (name === "kind") kind = value!;
      else if (name === "label") label = value!.trim() || null;
    }
    if (kind === null || !KEBAB_CASE.test(kind)) continue;
    start = { kind, label };
    end = false;
  }
  return start === null && !end ? null : { start, end };
}

function botSectionTitle(marker: BotSectionMarker): string {
  return (
    marker.label ??
    marker.kind
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  );
}

/** "Status Check - 11:18:04", in the client's local time. */
export function formatBotSectionLabel(marker: BotSectionMarker, startedAt: string): string {
  const title = botSectionTitle(marker);
  const instant = DateTime.make(startedAt);
  if (Option.isNone(instant)) return title;
  const { hour, minute, second } = DateTime.toParts(
    DateTime.setZone(instant.value, DateTime.zoneMakeLocal()),
  );
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${title} - ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

/**
 * A section starts at the turn whose reply opens it, and runs until the next
 * opening marker's turn, an end marker (inclusive), or the last item.
 */
export function deriveBotSectionSpans<T>(
  items: ReadonlyArray<T>,
  read: {
    readonly markers: (item: T) => BotSectionMessageMarkers | null;
    readonly startsTurn: (item: T) => boolean;
  },
): BotSectionSpan[] {
  const spans: BotSectionSpan[] = [];
  let open: Omit<BotSectionSpan, "endIndex" | "closed"> | null = null;
  let turnStart = 0;
  // Sections never overlap: a later one starts after the previous marker or end.
  let floor = 0;
  for (const [index, item] of items.entries()) {
    if (read.startsTurn(item)) turnStart = index;
    const markers = read.markers(item);
    if (markers === null) continue;
    if (markers.start !== null) {
      const startIndex = Math.max(turnStart, floor);
      if (open !== null) spans.push({ ...open, endIndex: startIndex - 1, closed: true });
      open = { marker: markers.start, markerIndex: index, startIndex };
      floor = index + 1;
    }
    if (markers.end && open !== null) {
      spans.push({ ...open, endIndex: index, closed: true });
      open = null;
      floor = index + 1;
    }
  }
  if (open !== null) spans.push({ ...open, endIndex: items.length - 1, closed: false });
  return spans;
}
