import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "./models.ts";
import {
  adoptUmbrellaMember,
  findUmbrellaMembership,
  removeUmbrellaMember,
  restoreUmbrellaMember,
  umbrellaAdoptionTargets,
  umbrellaMemberLabel,
  umbrellaMembersForThread,
  umbrellaMembersInFiles,
} from "./umbrella.ts";

const environmentId = EnvironmentId.make("desktop");
const apiIdentity = {
  canonicalKey: "github.com/acme/api",
  locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: "x" },
};
const project = (
  id: string,
  workspaceRoot: string,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject => ({
  environmentId,
  id: ProjectId.make(id),
  title: id,
  workspaceRoot,
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  ...overrides,
});
const umbrella = project("acme", "/clients/acme", {
  umbrellaMembers: [
    {
      path: "/clients/acme/api",
      relativePath: "api",
      repositoryIdentity: apiIdentity,
      source: "nested",
    },
  ],
});

describe("umbrella settings edits", () => {
  it("excludes a discovered member, restores it, and forgets an adopted one", () => {
    const removed = removeUmbrellaMember(umbrella, undefined, {
      path: "/clients/acme/api",
      source: "nested",
    });
    expect(removed).toEqual({
      umbrellaAdoptedPaths: [],
      umbrellaExcludedPaths: ["/clients/acme/api"],
    });
    expect(restoreUmbrellaMember(umbrella, removed, "/clients/acme/api")).toEqual({
      umbrellaAdoptedPaths: [],
      umbrellaExcludedPaths: [],
    });

    const adopted = adoptUmbrellaMember(
      umbrella,
      { umbrellaAdoptedPaths: ["/work/site"], umbrellaExcludedPaths: ["legacy"] },
      "/clients/acme/legacy",
    );
    // Adopting a checkout is the user's confirmation, so it turns the umbrella on.
    expect(adopted).toEqual({
      umbrellaEnabled: true,
      umbrellaAdoptedPaths: ["/work/site", "/clients/acme/legacy"],
      umbrellaExcludedPaths: [],
    });
    expect(
      removeUmbrellaMember(umbrella, adopted, { path: "/work/site", source: "adopted" }),
    ).toEqual({
      umbrellaEnabled: true,
      umbrellaAdoptedPaths: ["/clients/acme/legacy"],
      umbrellaExcludedPaths: [],
    });
  });
});

describe("umbrella membership", () => {
  it("matches a project by folder on the same environment or by repository anywhere", () => {
    const here = project("api-here", "/clients/acme/api");
    const laptop = project("api-laptop", "/home/me/api", {
      environmentId: EnvironmentId.make("laptop"),
      repositoryIdentity: apiIdentity,
    });
    const elsewhere = project("api-elsewhere", "/clients/acme/api", {
      environmentId: EnvironmentId.make("laptop"),
    });
    const projects = [umbrella, here, laptop, elsewhere];

    expect(findUmbrellaMembership(here, projects)).toMatchObject({
      umbrella: { id: umbrella.id },
      match: "folder",
    });
    // Another machine's clone only groups under the umbrella; removing it must not exclude the
    // umbrella's own checkout.
    expect(findUmbrellaMembership(laptop, projects)).toMatchObject({
      member: { relativePath: "api" },
      match: "repository",
    });
    expect(findUmbrellaMembership(elsewhere, projects)).toBeNull();
    expect(umbrellaAdoptionTargets(here, projects)).toEqual([]);
    expect(umbrellaAdoptionTargets(project("site", "/work/site"), projects)).toEqual([umbrella]);
    expect(umbrellaAdoptionTargets(elsewhere, projects)).toEqual([]);
  });

  it("labels outside members by folder name", () => {
    expect(umbrellaMemberLabel({ relativePath: "sites/web" })).toBe("sites/web");
    expect(umbrellaMemberLabel({ relativePath: "../../work/acme-site" })).toBe("acme-site");
  });
});

describe("umbrellaMembersInFiles", () => {
  const members = [
    { relativePath: "api" },
    { relativePath: "apps" },
    { relativePath: "apps/web" },
    { relativePath: "../../design/site" },
  ];
  const labels = (touched: ReadonlyArray<{ relativePath: string } | null>) =>
    touched.map((member) => member?.relativePath ?? null);

  it("names each member a file sits in once, in member order, and the root for the rest", () => {
    expect(
      labels(
        umbrellaMembersInFiles(
          members,
          ["apps/web/index.ts", "api/routes.txt", "api/README.md", "apps-notes.md"],
          false,
        ),
      ),
    ).toEqual([null, "api", "apps/web"]);
    expect(labels(umbrellaMembersInFiles(members, ["apps/README.md"], false))).toEqual(["apps"]);
    expect(
      labels(umbrellaMembersInFiles(members, ["../../design/site/index.html"], false)),
    ).toEqual(["../../design/site"]);
    expect(umbrellaMembersInFiles([], ["README.md"], false)).toEqual([]);
  });

  it("finds adopted members under the worktree folder's _external", () => {
    expect(
      labels(umbrellaMembersInFiles(members, ["_external/site/index.html", "api/a.ts"], true)),
    ).toEqual(["api", "../../design/site"]);
  });
});

describe("umbrellaMembersForThread", () => {
  const members = [
    { path: "/clients/acme/api", relativePath: "api" },
    { path: "/clients/acme/apps/web", relativePath: "apps/web" },
    { path: "/design/site", relativePath: "../../design/site" },
    { path: "/other/site", relativePath: "../../other/site" },
  ];

  it("maps members into a worktree-mode thread's folder, adopted ones under _external", () => {
    expect(
      umbrellaMembersForThread(members, "/worktrees/acme/feature-1/").map((m) => m.path),
    ).toEqual([
      "/worktrees/acme/feature-1/api",
      "/worktrees/acme/feature-1/apps/web",
      "/worktrees/acme/feature-1/_external/site",
      "/worktrees/acme/feature-1/_external/site-2",
    ]);
    expect(umbrellaMembersForThread(members.slice(1, 2), "C:\\worktrees\\acme\\f")[0]?.path).toBe(
      "C:\\worktrees\\acme\\f\\apps\\web",
    );
    expect(umbrellaMembersForThread(members, null)).toBe(members);
  });
});
