import { describe, expect, it } from "vite-plus/test";

import { threadsHostedByOtherWindows } from "./previewHosting";

describe("threadsHostedByOtherWindows", () => {
  it("collects open secondary windows' threads and ignores its own, closed and broken lists", () => {
    const hosted = threadsHostedByOtherWindows(
      [
        ["t3code:desktop-window-previews:2", JSON.stringify(["env:a", "env:b"])],
        ["t3code:desktop-window-previews:3", JSON.stringify(["env:c"])],
        ["t3code:desktop-window-previews:1", JSON.stringify(["env:own"])],
        ["t3code:desktop-window-previews:4", "not json"],
        ["t3code:other", JSON.stringify(["env:x"])],
      ],
      new Set([1, 2, 4]),
      1,
    );

    expect([...hosted].toSorted()).toEqual(["env:a", "env:b"]);
  });
});
