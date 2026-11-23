import { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { foldThreadFeedSections, threadFeedSectionFolds } from "./threadFeedSections";

const at = "2026-01-01T11:18:04.000Z";
const message = (id: string, role: "user" | "assistant", text = id): ThreadFeedEntry => ({
  type: "message",
  id,
  createdAt: at,
  message: {
    id: MessageId.make(id),
    role,
    text,
    attachments: [],
    runId: null,
    streaming: false,
    visibility: "local",
    sourceThreadId: ThreadId.make("thread"),
    createdAt: at,
    updatedAt: at,
  },
});
const runFold = (id: string): ThreadFeedEntry => ({
  type: "run-fold",
  id: `run-fold:${id}`,
  createdAt: at,
  runId: RunId.make(id),
  label: "Worked for 3s",
  expanded: false,
});
const thinking: ThreadFeedEntry = {
  type: "thinking",
  id: "live-activity-row",
  createdAt: at,
  runId: null,
};

describe("foldThreadFeedSections", () => {
  const exchange = [
    message("before", "user"),
    message("ask", "user"),
    message("relay", "assistant", '<!-- t3bot:section kind="status-check" -->\nAll green.'),
    message("reply", "user"),
    message("done", "assistant", "Done.\n<!-- t3bot:section-end -->"),
  ];
  const feed = [...exchange, message("after", "user")];
  // The presentation adds rows of its own between the feed's entries.
  const presented = (entries: ReadonlyArray<ThreadFeedEntry>) => [
    ...entries.slice(0, 4),
    runFold("r2"),
    ...entries.slice(4),
    thinking,
  ];
  const expandedSection = ["ask", "relay", "reply", "run-fold:r2", "done"];

  it.each<[string, ReadonlyArray<ThreadFeedEntry>, boolean, ReadonlyArray<string>, string[]]>([
    [
      "folds a closed section with the rows derived inside it",
      feed,
      false,
      [],
      ["before", "run-fold:section:relay", "after", "live-activity-row"],
    ],
    [
      "opens a closed section from the expanded set",
      feed,
      false,
      ["section:relay"],
      ["before", "run-fold:section:relay", ...expandedSection, "after", "live-activity-row"],
    ],
    [
      "keeps a section open while the turn that ends it runs",
      exchange,
      true,
      [],
      ["before", "run-fold:section-open:relay", ...expandedSection, "live-activity-row"],
    ],
  ])("%s", (_name, entries, isWorking, expanded, expected) => {
    const folded = foldThreadFeedSections(
      presented(entries),
      entries,
      threadFeedSectionFolds(entries, isWorking),
      new Set(expanded.map((id) => RunId.make(id))),
      new Map(),
    );
    expect(folded.map((row) => row.id)).toEqual(expected);
  });
});
