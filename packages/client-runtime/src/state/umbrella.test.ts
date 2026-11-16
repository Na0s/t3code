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
    expect(adopted).toEqual({
      umbrellaAdoptedPaths: ["/work/site", "/clients/acme/legacy"],
      umbrellaExcludedPaths: [],
    });
    expect(
      removeUmbrellaMember(umbrella, adopted, { path: "/work/site", source: "adopted" }),
    ).toEqual({ umbrellaAdoptedPaths: ["/clients/acme/legacy"], umbrellaExcludedPaths: [] });
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

    expect(findUmbrellaMembership(here, projects)?.umbrella.id).toBe(umbrella.id);
    expect(findUmbrellaMembership(laptop, projects)?.member.relativePath).toBe("api");
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
