import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { makeIndex } from "./UmbrellaMemberIndex.ts";

it.effect("leaves out only the members of the umbrella rooted at the work tree", () =>
  Effect.gen(function* () {
    const index = makeIndex();
    yield* index.replace(
      new Map([
        ["/clients/acme", [{ path: "/clients/acme/api", relativePath: "api" }]],
        ["/clients/beta", [{ path: "/work/beta-site", relativePath: "../../work/beta-site" }]],
      ]),
    );

    expect(index.memberPathsWithin("/clients/acme")).toEqual(["api"]);
    // A repository that merely encloses an umbrella, or holds another umbrella's adopted
    // checkout, keeps its own view.
    expect(index.memberPathsWithin("/clients")).toEqual([]);
    expect(index.memberPathsWithin("/work")).toEqual([]);
    expect(index.memberPathsWithin("/clients/beta")).toEqual([]);
  }),
);
