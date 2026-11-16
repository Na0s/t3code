import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import { resolveUmbrellaMembers } from "./UmbrellaMembership.ts";

it.effect("combines discovered and adopted checkouts and drops exclusions", () =>
  Effect.gen(function* () {
    const members = resolveUmbrellaMembers({
      path: yield* Path.Path,
      workspaceRoot: "/clients/acme",
      nested: ["/clients/acme/api", "/clients/acme/sites/web", "/clients/acme/legacy"],
      adopted: ["/work/acme-mobile", "api", "/clients/acme"],
      excluded: ["legacy"],
      identityOf: (memberPath) =>
        memberPath.endsWith("api")
          ? {
              canonicalKey: "github.com/acme/api",
              locator: { source: "git-remote", remoteName: "origin", remoteUrl: "x" },
            }
          : null,
    });

    expect(
      members.map(({ relativePath, source, repositoryIdentity }) => ({
        relativePath,
        source,
        identity: repositoryIdentity?.canonicalKey ?? null,
      })),
    ).toEqual([
      { relativePath: "../../work/acme-mobile", source: "adopted", identity: null },
      { relativePath: "api", source: "nested", identity: "github.com/acme/api" },
      { relativePath: "sites/web", source: "nested", identity: null },
    ]);
  }).pipe(Effect.provide(Path.layer)),
);
