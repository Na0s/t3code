// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { discoverNestedRepositories } from "./umbrellaDiscovery.ts";

const makeTree = (entries: ReadonlyArray<string>) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "umbrella-discovery-"));
  for (const entry of entries) {
    const target = NodePath.join(root, entry);
    if (entry.endsWith("/.git-file")) {
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(NodePath.dirname(target), ".git"), "gitdir: elsewhere\n");
    } else {
      NodeFS.mkdirSync(target, { recursive: true });
    }
  }
  return root;
};

it.effect("finds checkouts under the root without entering skipped folders", () =>
  Effect.gen(function* () {
    const root = makeTree([
      "api/.git",
      "api/vendor/inner/.git",
      "sites/marketing/.git",
      "copy/drafts",
      ".hidden/repo/.git",
      "node_modules/pkg/.git",
      "worktree/.git-file",
      "worktree/nested/.git",
      "one/two/three/.git",
      "one/two/three/four/.git",
    ]);
    try {
      const found = yield* discoverNestedRepositories(root);
      expect(found.map((path) => NodePath.relative(root, path))).toEqual([
        "api",
        NodePath.join("one", "two", "three"),
        NodePath.join("sites", "marketing"),
      ]);
      const shallow = yield* discoverNestedRepositories(root, { maxDepth: 1 });
      expect(shallow.map((path) => NodePath.relative(root, path))).toEqual(["api"]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  }),
);
