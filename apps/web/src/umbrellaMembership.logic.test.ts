import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveUmbrellaMenuAction,
  umbrellaConfirmationMessage,
  umbrellaMembershipActions,
  umbrellaMenuItems,
} from "./umbrellaMembership.logic";

const desktop = EnvironmentId.make("desktop");
const project = (
  id: string,
  workspaceRoot: string,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject => ({
  environmentId: desktop,
  id: ProjectId.make(id),
  title: id,
  workspaceRoot,
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  umbrellaMembers: [],
  ...overrides,
});
const member = (path: string, relativePath: string) => ({
  path,
  relativePath,
  repositoryIdentity: null,
  source: "nested" as const,
});

const acme = project("acme", "/clients/acme", {
  umbrellaMembers: [member("/clients/acme/api", "api"), member("/clients/acme/web", "web")],
});
const globex = project("globex", "/clients/globex", {
  umbrellaMembers: [member("/clients/globex/site", "site")],
});
const api = project("api", "/clients/acme/api");
const web = project("web", "/clients/acme/web");
const tools = project("tools", "/work/tools");
const projects = [acme, globex, api, web, tools];

describe("umbrellaMembershipActions", () => {
  it("offers a free project every umbrella on its environment and a member only its exit", () => {
    const free = umbrellaMembershipActions([tools], projects);
    expect(free.adoptions.map(({ umbrella, path }) => [umbrella.id, path])).toEqual([
      ["acme", "/work/tools"],
      ["globex", "/work/tools"],
    ]);
    expect(free.removals).toEqual([]);

    const joined = umbrellaMembershipActions([api], projects);
    expect(joined.adoptions).toEqual([]);
    expect(joined.removals.map(({ umbrella, member }) => [umbrella.id, member.path])).toEqual([
      ["acme", "/clients/acme/api"],
    ]);
  });

  it("lists each folded project of an umbrella group once and ignores scratch projects", () => {
    const scratch = project("scratch", "/tmp/scratch", { isScratch: true });
    const actions = umbrellaMembershipActions([acme, api, web, api, scratch], projects);
    expect(actions.adoptions).toEqual([]);
    expect(actions.removals.map(({ member }) => member.relativePath)).toEqual(["api", "web"]);
  });
});

describe("umbrellaMenuItems", () => {
  it("maps clicked ids back to the adoption or removal they name", () => {
    const actions = {
      adoptions: umbrellaMembershipActions([tools], projects).adoptions,
      removals: umbrellaMembershipActions([api, web], projects).removals,
    };
    const items = umbrellaMenuItems(actions);
    expect(items.map((item) => [item.label, item.children?.map((child) => child.label)])).toEqual([
      ["Add to umbrella", ["acme", "globex"]],
      ["Remove from umbrella", ["api (acme)", "web (acme)"]],
    ]);
    const globexId = items[0]!.children![1]!.id;
    expect(resolveUmbrellaMenuAction(actions, globexId)).toMatchObject({
      kind: "adopt",
      umbrella: { id: "globex" },
      path: "/work/tools",
    });
    const webId = items[1]!.children![1]!.id;
    expect(resolveUmbrellaMenuAction(actions, webId)).toMatchObject({
      kind: "remove",
      member: { path: "/clients/acme/web" },
    });
    expect(resolveUmbrellaMenuAction(actions, "project-settings")).toBeNull();
  });

  it("uses a single item when one removal is possible", () => {
    const actions = umbrellaMembershipActions([api], projects);
    expect(umbrellaMenuItems(actions)).toEqual([
      { id: "umbrella-remove:0", label: "Remove from umbrella", detail: "acme" },
    ]);
    expect(resolveUmbrellaMenuAction(actions, "umbrella-remove:0")?.kind).toBe("remove");
  });
});

describe("umbrellaConfirmationMessage", () => {
  it("names every checkout the umbrella will take in", () => {
    expect(
      umbrellaConfirmationMessage("Acme", [
        { relativePath: "api" },
        { relativePath: "../../work/acme-site" },
      ]),
    ).toBe(
      [
        "Use Acme as an umbrella?",
        "Turns record checkpoints in these checkouts, and reverting a turn restores them:",
        "• api",
        "• acme-site",
      ].join("\n"),
    );
  });
});
