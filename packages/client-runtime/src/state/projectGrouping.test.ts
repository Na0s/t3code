import { EnvironmentId, ProjectId, SourceControlProviderKind } from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "./models.ts";
import { chooseLoadBalancedEnvironment } from "../load-balancing.ts";
import {
  buildProjectGroups,
  deriveLogicalProjectKeyFromSettings,
  pickableProjectGroups,
  derivePhysicalProjectKey,
  findCoveredFolderProject,
  isCoveringProject,
  resolveGroupDefaultProject,
  resolveScratchProjectScopeKey,
  sortProjectsByGroupOrder,
  type ProjectGroupingSettings,
} from "./projectGrouping.ts";

const environmentId = EnvironmentId.make("environment");

describe("load balancing shared project machines", () => {
  const now = 100_000;
  const resources = {
    sampledAt: now,
    cpuUtilization: 0.2,
    cpuCount: 8,
    availableMemoryBytes: 8_000,
    totalMemoryBytes: 16_000,
  };

  it("compares three machines using free capacity and preference", () => {
    const candidates = [
      { environmentId: "busy", resources: { ...resources, cpuUtilization: 0.9 }, weight: 1 },
      { environmentId: "idle", resources, weight: 1 },
      { environmentId: "preferred", resources: { ...resources, cpuCount: 4 }, weight: 3 },
    ];
    expect(chooseLoadBalancedEnvironment(candidates, now)).toBe("preferred");
    expect(chooseLoadBalancedEnvironment(candidates.slice(0, 2), now)).toBe("idle");
  });

  it("rejects stale, unknown, excluded and saturated machines", () => {
    expect(
      chooseLoadBalancedEnvironment(
        [
          {
            environmentId: "stale",
            resources: { ...resources, sampledAt: now - 15_001 },
            weight: 1,
          },
          { environmentId: "unknown", resources: null, weight: 1 },
          {
            environmentId: "no-cpu-sample",
            resources: { ...resources, cpuUtilization: null },
            weight: 1,
          },
          { environmentId: "excluded", resources, weight: 0 },
          {
            environmentId: "cpu-full",
            resources: { ...resources, cpuUtilization: 0.95 },
            weight: 1,
          },
          {
            environmentId: "memory-full",
            resources: { ...resources, availableMemoryBytes: 100 },
            weight: 1,
          },
        ],
        now,
      ),
    ).toBeNull();
  });

  it("uses client receipt time when host clocks differ", () => {
    const candidate = {
      environmentId: "different-clock",
      resources: { ...resources, sampledAt: now + 60_000 },
      receivedAt: now,
      weight: 1,
    };
    expect(chooseLoadBalancedEnvironment([candidate], now)).toBe("different-clock");
    expect(chooseLoadBalancedEnvironment([candidate], now + 15_001)).toBeNull();
  });
});
const repositoryIdentity = {
  canonicalKey: "github.com/t3tools/t3code",
  locator: {
    source: "git-remote" as const,
    remoteName: "upstream",
    remoteUrl: "https://github.com/t3tools/t3code.git",
  },
  provider: SourceControlProviderKind.make("github"),
  owner: "t3tools",
  name: "t3code",
  displayName: "T3 Code",
};

function makeProject(
  id: string,
  workspaceRoot: string,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function settings(
  mode: ProjectGroupingSettings["sidebarProjectGroupingMode"],
  overrides: ProjectGroupingSettings["sidebarProjectGroupingOverrides"] = {},
): ProjectGroupingSettings {
  return {
    sidebarProjectGroupingMode: mode,
    sidebarProjectGroupingOverrides: overrides,
  };
}

describe("buildProjectGroups", () => {
  it.each(["repository", "repository_path", "separate"] as const)(
    "keeps scratch project ownership separate by default in %s mode",
    (mode) => {
      const projects = [
        makeProject("scratch-local", "/local/scratch", {
          isScratch: true,
          repositoryIdentity: null,
        }),
        makeProject("scratch-remote", "/remote/scratch", {
          environmentId: EnvironmentId.make("remote"),
          isScratch: true,
          repositoryIdentity: null,
        }),
      ];
      const groups = buildProjectGroups({ projects, settings: settings(mode) });
      expect(groups.map((group) => group.key)).toEqual(projects.map(derivePhysicalProjectKey));
      expect(groups.map((group) => group.memberProjectRefs)).toEqual(
        projects.map((project) => [
          { environmentId: project.environmentId, projectId: project.id },
        ]),
      );
      expect(
        buildProjectGroups({ projects, settings: settings(mode), groupScratchProjects: true }),
      ).toHaveLength(1);
    },
  );

  it.each(["repository", "repository_path", "separate"] as const)(
    "migrates a pre-config %s scratch selection and retains it after the original host is removed",
    (mode) => {
      const local = makeProject("scratch-local", "/local/repo/scratch", {
        repositoryIdentity: { ...repositoryIdentity, rootPath: "/local/repo" },
      });
      const remote = makeProject("scratch-remote", "/remote/scratch", {
        environmentId: EnvironmentId.make("remote"),
        repositoryIdentity: null,
        isScratch: true,
      });
      const groupingSettings = settings(mode);
      const selectedBeforeConfig = deriveLogicalProjectKeyFromSettings(local, groupingSettings);
      const loaded = [{ ...local, isScratch: true as const }, remote];
      const migrated = resolveScratchProjectScopeKey(
        selectedBeforeConfig,
        loaded,
        groupingSettings,
      );
      const scratchKey = buildProjectGroups({
        projects: loaded,
        settings: groupingSettings,
        groupScratchProjects: true,
      })[0]!.key;
      expect(migrated).toBe(scratchKey);
      expect(resolveScratchProjectScopeKey(migrated, [remote], groupingSettings)).toBe(scratchKey);
      expect(
        buildProjectGroups({
          projects: [remote],
          settings: groupingSettings,
          groupScratchProjects: true,
        })[0]?.memberProjectRefs,
      ).toEqual([{ environmentId: remote.environmentId, projectId: remote.id }]);
    },
  );

  it("retains a repository filter that still belongs to an ordinary project", () => {
    const scratch = makeProject("scratch", "/scratch", { isScratch: true });
    const ordinary = makeProject("ordinary", "/ordinary");
    const key = deriveLogicalProjectKeyFromSettings(ordinary, settings("repository"));
    expect(resolveScratchProjectScopeKey(key, [scratch, ordinary])).toBe(key);
  });

  it.each(["repository", "repository_path", "separate"] as const)(
    "coalesces scratch homes in %s mode without merging ordinary same-title projects",
    (mode) => {
      const remoteEnvironmentId = EnvironmentId.make("remote");
      const projects = [
        makeProject("scratch-local", "/local/scratch", {
          title: "No project",
          isScratch: true,
          repositoryIdentity: null,
        }),
        makeProject("scratch-remote", "/remote/scratch", {
          title: "No project",
          environmentId: remoteEnvironmentId,
          isScratch: true,
        }),
        makeProject("scratch-duplicate", "/remote/scratch/", {
          title: "No project",
          environmentId: remoteEnvironmentId,
          isScratch: true,
          repositoryIdentity: null,
          updatedAt: "2026-07-02T00:00:00.000Z",
        }),
        makeProject("ordinary", "/ordinary", { title: "No project" }),
        makeProject("reserved-collision", "/other", {
          title: "No project",
          repositoryIdentity: { ...repositoryIdentity, canonicalKey: "\0no-project" },
        }),
      ];
      const groups = buildProjectGroups({
        projects,
        groupScratchProjects: true,
        settings: settings(mode, { [derivePhysicalProjectKey(projects[0]!)]: "separate" }),
        preferredEnvironmentId: remoteEnvironmentId,
      });
      expect(groups).toHaveLength(3);
      const scratch = groups.find((group) => group.representative.isScratch)!;
      expect(scratch.label).toBe("No project");
      expect(scratch.representative.id).toBe(projects[2]?.id);
      expect(scratch.members).toHaveLength(2);
      expect(scratch.memberProjectRefs).toEqual(
        projects.slice(0, 3).map((project) => ({
          environmentId: project.environmentId,
          projectId: project.id,
        })),
      );
      expect(resolveScratchProjectScopeKey(derivePhysicalProjectKey(projects[1]!), projects)).toBe(
        scratch.key,
      );
      expect(resolveScratchProjectScopeKey(derivePhysicalProjectKey(projects[3]!), projects)).toBe(
        derivePhysicalProjectKey(projects[3]!),
      );
      expect(groups.filter((group) => !group.representative.isScratch)).toHaveLength(2);
    },
  );

  it("preserves every physical clone as a selectable member in repository modes", () => {
    const projects = [
      makeProject("t3code", "/work/t3code"),
      makeProject("t3code-2", "/work/t3code-2"),
      makeProject("t3code-3", "/work/t3code-3"),
    ];

    for (const mode of ["repository", "repository_path"] as const) {
      const groups = buildProjectGroups({ projects, settings: settings(mode) });
      expect(groups).toHaveLength(1);
      expect(groups[0]?.members.map((member) => member.project.id)).toEqual([
        "t3code",
        "t3code-2",
        "t3code-3",
      ]);
      expect(groups[0]?.memberProjectRefs).toHaveLength(3);
    }
  });

  it("represents a repository group by its root checkout, even when it was added last", () => {
    const remoteEnvironmentId = EnvironmentId.make("remote");
    const local = { ...repositoryIdentity, rootPath: "/work/workspace" };
    const remote = { ...repositoryIdentity, rootPath: "/srv/workspace" };
    const archivedTool = makeProject("old-tool", "/work/workspace/_archive/old-tool", {
      repositoryIdentity: local,
    });
    const app = makeProject("app-a", "/work/workspace/app-a", { repositoryIdentity: local });
    const remoteApp = makeProject("remote-app", "/srv/workspace/app-a", {
      environmentId: remoteEnvironmentId,
      repositoryIdentity: remote,
    });
    const remoteRoot = makeProject("remote-root", "/srv/workspace", {
      environmentId: remoteEnvironmentId,
      repositoryIdentity: remote,
    });
    const root = makeProject("workspace", "/work/workspace", { repositoryIdentity: local });
    const representativeOf = (
      projects: ReadonlyArray<EnvironmentProject>,
      preferredEnvironmentId: EnvironmentId | null = null,
    ) =>
      buildProjectGroups({ projects, settings: settings("repository"), preferredEnvironmentId })[0]
        ?.representative.id;

    expect(representativeOf([archivedTool, app, root])).toBe("workspace");
    expect(representativeOf([archivedTool, app, remoteApp, remoteRoot, root], environmentId)).toBe(
      "workspace",
    );
    expect(
      representativeOf([archivedTool, app, remoteApp, remoteRoot, root], remoteEnvironmentId),
    ).toBe("remote-root");
    // A local root is not worth leaving the current environment for.
    expect(representativeOf([archivedTool, root, remoteApp], remoteEnvironmentId)).toBe(
      "remote-app",
    );
    expect(representativeOf([archivedTool, app])).toBe("old-tool");

    // A new thread with no current or last-used project starts from the first project's group.
    const all = [archivedTool, app, remoteApp, remoteRoot, root];
    expect(resolveGroupDefaultProject(archivedTool, all, settings("repository")).id).toBe(
      "workspace",
    );
    expect(resolveGroupDefaultProject(remoteApp, all, settings("repository")).id).toBe(
      "remote-root",
    );
    expect(resolveGroupDefaultProject(archivedTool, all, settings("separate")).id).toBe("old-tool");
  });

  it("keeps a fork apart from its upstream checkout and labels it by its own remote", () => {
    const fork = makeProject("fork", "/work/t3code-fork", {
      repositoryIdentity: {
        ...repositoryIdentity,
        origin: {
          canonicalKey: "github.com/julius/t3code-fork",
          displayName: "julius/t3code-fork",
        },
      },
    });
    const forkWorktree = makeProject("fork-2", "/work/t3code-fork-2", {
      repositoryIdentity: fork.repositoryIdentity,
    });
    const projects = [makeProject("t3code", "/work/t3code"), fork, forkWorktree];

    const groups = buildProjectGroups({ projects, settings: settings("repository") });
    expect(groups.map((group) => group.key)).toEqual([
      "github.com/t3tools/t3code",
      "github.com/julius/t3code-fork",
    ]);
    expect(groups[1]?.members.map((member) => member.project.id)).toEqual(["fork", "fork-2"]);
    expect(groups[1]?.label).toBe("julius/t3code-fork");
  });

  // regression: #15049 a rename to the repository name snapped back to the display path
  it("labels a renamed group by its title even when it matches the repository name", () => {
    const folderTitles = [
      makeProject("t3code", "/work/t3code", { title: "t3code" }),
      makeProject("t3code-2", "/work/t3code-2", { title: "t3code" }),
    ];
    const renamed = folderTitles.map((project) => ({ ...project, hasCustomTitle: true }));

    const label = (projects: ReadonlyArray<EnvironmentProject>) =>
      buildProjectGroups({ projects, settings: settings("repository") })[0]?.label;
    expect(label(folderTitles)).toBe("T3 Code");
    expect(label(renamed)).toBe("t3code");
  });

  it("labels a group by its repository when clones disagree on its casing", () => {
    // A subfolder project, its repository root, and a clone whose remote URL is
    // lowercased: no shared title or display name, but one repository.
    const subfolder = makeProject("design-study", "/work/NewCo/reference/design-study");
    const root = makeProject("NewCo", "/work/NewCo");
    const lowercasedClone = makeProject("NewCo", "/remote/NewCo", {
      environmentId: EnvironmentId.make("remote"),
      repositoryIdentity: { ...repositoryIdentity, name: "T3CODE", displayName: "t3 code" },
    });

    const groups = buildProjectGroups({
      projects: [subfolder, root, lowercasedClone],
      settings: settings("repository"),
      preferredEnvironmentId: environmentId,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("T3 Code");

    // A subfolder group in repository_path mode keeps its own title.
    const localIdentity = { ...repositoryIdentity, rootPath: "/work/t3code" };
    const pathGroups = buildProjectGroups({
      projects: [
        makeProject("design", "/work/t3code/design", {
          title: "Design docs",
          hasCustomTitle: true,
          repositoryIdentity: localIdentity,
        }),
        makeProject("design", "/remote/t3code/design", {
          environmentId: EnvironmentId.make("remote"),
          repositoryIdentity: {
            ...repositoryIdentity,
            rootPath: "/remote/t3code",
            name: "T3CODE",
            displayName: "t3 code",
          },
        }),
        makeProject("t3code", "/work/t3code", { repositoryIdentity: localIdentity }),
      ],
      settings: settings("repository_path"),
      preferredEnvironmentId: environmentId,
    });
    expect(pathGroups.map((group) => group.label)).toEqual(["Design docs", "t3code"]);
  });

  it("applies a physical-project override without dropping its siblings", () => {
    const first = makeProject("t3code", "/work/t3code");
    const second = makeProject("t3code-2", "/work/t3code-2");
    const third = makeProject("t3code-3", "/work/t3code-3");
    const groups = buildProjectGroups({
      projects: [first, second, third],
      settings: settings("repository", {
        [derivePhysicalProjectKey(second)]: "separate",
      }),
    });

    expect(groups).toHaveLength(2);
    expect(groups.flatMap((group) => group.members.map((member) => member.project.id))).toEqual([
      "t3code",
      "t3code-3",
      "t3code-2",
    ]);
  });

  it("dedupes stale registrations at one physical path using the freshest project", () => {
    const stale = makeProject("stale", "/work/t3code", {
      repositoryIdentity: null,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const fresh = makeProject("fresh", "/work/t3code/", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });

    const groups = buildProjectGroups({
      projects: [stale, fresh],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toHaveLength(1);
    expect(groups[0]?.representative.id).toBe("fresh");
    expect(groups[0]?.memberProjectRefs).toHaveLength(2);
  });

  it("uses the freshest winner's repository identity when stale duplicates disagree", () => {
    const staleIdentity = {
      ...repositoryIdentity,
      canonicalKey: "github.com/t3tools/old-repository",
      name: "old-repository",
      displayName: "Old Repository",
    };
    const stale = makeProject("stale", "/work/t3code", {
      repositoryIdentity: staleIdentity,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const fresh = makeProject("fresh", "/work/t3code/", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const sibling = makeProject("sibling", "/work/t3code-2");

    const groups = buildProjectGroups({
      projects: [stale, fresh, sibling],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["fresh", "sibling"]);
  });

  it("uses the freshest identity-bearing duplicate when the winner lacks identity", () => {
    const staleIdentity = {
      ...repositoryIdentity,
      canonicalKey: "github.com/t3tools/old-repository",
      name: "old-repository",
      displayName: "Old Repository",
    };
    const staleIdentified = makeProject("stale-identified", "/work/t3code", {
      repositoryIdentity: staleIdentity,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const freshIdentified = makeProject("fresh-identified", "/work/t3code/", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const winner = makeProject("winner", "/work/t3code", {
      repositoryIdentity: null,
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    const sibling = makeProject("sibling", "/work/t3code-2");

    const groups = buildProjectGroups({
      projects: [staleIdentified, freshIdentified, winner, sibling],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["winner", "sibling"]);
  });
});

describe("project pins and archives", () => {
  const at = "2026-07-02T00:00:00.000Z";
  const remote = EnvironmentId.make("remote");
  const group = (...projects: EnvironmentProject[]) =>
    buildProjectGroups({ projects, settings: settings("repository") })[0]!;

  it("keeps a project visible while its machines disagree", () => {
    const local = makeProject("local", "/work/t3code");
    const other = makeProject("remote", "/work/t3code", { environmentId: remote });
    const partial = group({ ...local, pinnedAt: at, archivedAt: at }, other);
    expect(partial).toMatchObject({ pinned: true, archived: false });
    expect(group({ ...local, archivedAt: at }, { ...other, archivedAt: at }).archived).toBe(true);
  });

  it("offers pinned projects first and leaves archived ones out", () => {
    const pickable = pickableProjectGroups([
      { key: "a", pinned: false, archived: false },
      { key: "b", pinned: true, archived: true },
      { key: "c", pinned: true, archived: false },
      { key: "d", pinned: false, archived: true },
    ]);
    expect(pickable.map((entry) => entry.key)).toEqual(["c", "a"]);
  });
});

describe("sortProjectsByGroupOrder", () => {
  const remote = EnvironmentId.make("remote");
  const ref = (projectId: string, env = environmentId) => ({
    environmentId: env,
    projectId: ProjectId.make(projectId),
  });
  const project = (id: string, env: string = environmentId) => ({ id, environmentId: env });

  it("tells the same project id on two environments apart", () => {
    const sorted = sortProjectsByGroupOrder(
      [project("shared"), project("shared", remote)],
      [
        { memberProjectRefs: [ref("shared", remote)], pinned: false, archived: false },
        { memberProjectRefs: [ref("shared")], pinned: false, archived: false },
      ],
    );
    expect(sorted.map((entry) => entry.environmentId)).toEqual([remote, environmentId]);
  });

  it("lists pinned projects first and archived ones last, like the sidebar's project menu", () => {
    const sorted = sortProjectsByGroupOrder(
      [project("archived"), project("recent"), project("pinned"), project("unlisted")],
      [
        { memberProjectRefs: [ref("archived")], pinned: false, archived: true },
        { memberProjectRefs: [ref("recent")], pinned: false, archived: false },
        { memberProjectRefs: [ref("pinned")], pinned: true, archived: false },
      ],
    );
    expect(sorted.map((entry) => entry.id)).toEqual(["pinned", "recent", "archived", "unlisted"]);
  });
});

describe("folding covered projects", () => {
  const remote = EnvironmentId.make("remote");
  const identityOf = (name: string) => ({
    ...repositoryIdentity,
    canonicalKey: `github.com/acme/${name}`,
    locator: { ...repositoryIdentity.locator, remoteUrl: `https://github.com/acme/${name}.git` },
    name,
    displayName: name,
  });
  const shop = makeProject("shop", "/work/shop", {
    repositoryIdentity: null,
    trackedFolders: [
      {
        path: "/work/shop/api",
        name: "api",
        discovered: true,
        repositoryIdentity: identityOf("api"),
      },
      { path: "/work/shop/web", name: "web", discovered: true },
    ],
  });
  const api = makeProject("api", "/work/shop/api", { repositoryIdentity: identityOf("api") });
  const remoteApi = makeProject("api-remote", "/srv/api", {
    environmentId: remote,
    repositoryIdentity: identityOf("api"),
  });
  const web = makeProject("web", "/work/shop/web", { repositoryIdentity: identityOf("web") });
  const other = makeProject("other", "/work/other", { repositoryIdentity: identityOf("other") });
  const fold = (projects: EnvironmentProject[], groupingSettings = settings("repository")) =>
    buildProjectGroups({ projects, settings: groupingSettings, foldCoveredProjects: true });
  const refOf = (project: EnvironmentProject) => ({
    environmentId: project.environmentId,
    projectId: project.id,
  });

  it("folds the project in a covered folder, and the same repository on another environment", () => {
    const groups = fold([shop, api, remoteApi, web, other]);
    expect(groups.map((group) => group.label)).toEqual(["shop", "other"]);
    const [shopGroup] = groups;
    expect(shopGroup?.members.map((member) => member.project.id)).toEqual(["shop"]);
    expect(shopGroup?.memberProjectRefs).toEqual([
      refOf(shop),
      refOf(api),
      refOf(remoteApi),
      refOf(web),
    ]);
    expect(shopGroup?.folded.map(({ key, folderName }) => ({ key, folderName }))).toEqual([
      { key: "github.com/acme/api", folderName: "api" },
      { key: "github.com/acme/web", folderName: "web" },
    ]);
  });

  it("folds by folder only on the covering project's environment", () => {
    const elsewhere = makeProject("web-remote", "/work/shop/web", {
      environmentId: remote,
      repositoryIdentity: null,
    });
    expect(fold([shop, elsewhere]).map((group) => group.label)).toEqual(["shop", "web-remote"]);
  });

  it("leaves groups as they are unless asked, and keeps projects set to stay separate", () => {
    expect(
      buildProjectGroups({ projects: [shop, api], settings: settings("repository") }),
    ).toHaveLength(2);
    expect(
      fold([shop, api], settings("repository", { [derivePhysicalProjectKey(api)]: "separate" })),
    ).toHaveLength(2);
  });

  it("does not fold into an archived project", () => {
    expect(fold([{ ...shop, archivedAt: "2026-07-02T00:00:00.000Z" }, api])).toHaveLength(2);
  });

  it("follows a chain of covering projects to its end, and keeps a cycle apart", () => {
    const workspace = makeProject("workspace", "/work", {
      repositoryIdentity: null,
      trackedFolders: [{ path: "/work/shop", name: "shop" }],
    });
    const groups = fold([workspace, shop, api]);
    expect(groups.map((group) => group.label)).toEqual(["workspace"]);
    expect(groups[0]?.folded.map((entry) => entry.folderName).toSorted()).toEqual(["api", "shop"]);

    const a = makeProject("a", "/a", {
      repositoryIdentity: null,
      trackedFolders: [{ path: "/b", name: "b" }],
    });
    const b = makeProject("b", "/b", {
      repositoryIdentity: null,
      trackedFolders: [{ path: "/a", name: "a" }],
    });
    expect(fold([a, b]).map((group) => group.label)).toEqual(["a", "b"]);
  });

  effectIt.prop(
    "keeps every project in exactly one group and every group key once",
    {
      projects: Schema.Array(
        Schema.Struct({
          remote: Schema.Boolean,
          folder: Schema.Literals(["a", "b", "c", "d"]),
          repository: Schema.NullOr(Schema.Literals(["x", "y"])),
          covers: Schema.Array(
            Schema.Struct({
              folder: Schema.Literals(["a", "b", "c", "d"]),
              repository: Schema.NullOr(Schema.Literals(["x", "y"])),
            }),
          ),
          archived: Schema.Boolean,
        }),
      ),
    },
    ({ projects: specs }) => {
      const projects = specs.map((spec, index) =>
        makeProject(`p${index}`, `/${spec.folder}`, {
          ...(spec.remote ? { environmentId: remote } : {}),
          repositoryIdentity: spec.repository === null ? null : identityOf(spec.repository),
          trackedFolders: spec.covers.map((folder) => ({
            path: `/${folder.folder}`,
            name: folder.folder,
            ...(folder.repository === null
              ? {}
              : { repositoryIdentity: identityOf(folder.repository) }),
          })),
          ...(spec.archived ? { archivedAt: "2026-07-02T00:00:00.000Z" } : {}),
        }),
      );
      const plain = buildProjectGroups({ projects, settings: settings("repository") });
      const folded = fold(projects);
      const refs = folded.flatMap((group) =>
        group.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
      );
      expect(refs.toSorted()).toEqual(
        plain
          .flatMap((group) => group.memberProjectRefs)
          .map((ref) => `${ref.environmentId}:${ref.projectId}`)
          .toSorted(),
      );
      const keys = folded.flatMap((group) => [
        group.key,
        ...group.folded.map((entry) => entry.key),
      ]);
      expect(keys.toSorted()).toEqual(plain.map((group) => group.key).toSorted());
      for (const group of folded) {
        if (group.folded.length > 0) {
          expect(group.archived).toBe(false);
          expect(group.members.some(({ project }) => isCoveringProject(project))).toBe(true);
        }
      }
    },
  );
});

describe("findCoveredFolderProject", () => {
  const remote = EnvironmentId.make("remote");
  it("prefers the project in the folder over another clone of its repository", () => {
    const clone = makeProject("clone", "/clone", { environmentId: remote });
    const inFolder = makeProject("in-folder", "/work/t3code", { repositoryIdentity: null });
    const folder = { path: "/work/t3code", repositoryIdentity };
    expect(findCoveredFolderProject(folder, environmentId, [clone, inFolder])?.id).toBe(
      "in-folder",
    );
    expect(findCoveredFolderProject(folder, environmentId, [clone])?.id).toBe("clone");
    expect(findCoveredFolderProject({ path: "/work/t3code" }, environmentId, [clone])).toBe(
      undefined,
    );
  });
});
