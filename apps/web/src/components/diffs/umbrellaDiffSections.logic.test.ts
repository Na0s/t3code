import { describe, expect, it } from "vite-plus/test";

import { umbrellaDiffSections } from "./umbrellaDiffSections.logic";

const clean = { isRepo: true, hasWorkingTreeChanges: false };
const dirty = { isRepo: true, hasWorkingTreeChanges: true };
const branchOnly = {
  isRepo: true,
  hasWorkingTreeChanges: false,
  branchChanges: { baseRef: "main", insertions: 3, deletions: 0 },
};
const members = [
  { path: "/acme/api", relativePath: "api" },
  { path: "/acme/web", relativePath: "web" },
  { path: "/elsewhere/tools", relativePath: "../elsewhere/tools" },
];

const sectionPaths = (result: ReturnType<typeof umbrellaDiffSections>) =>
  result.sections.map((section) => section.memberPath);

describe("umbrellaDiffSections", () => {
  it("lists the root repository and only members with working tree or branch changes", () => {
    const result = umbrellaDiffSections({
      rootCwd: "/acme",
      rootLabel: "acme",
      rootIsRepo: true,
      members,
      statuses: [dirty, clean, branchOnly],
      selectedMemberPath: null,
    });
    expect(sectionPaths(result)).toEqual([null, "/acme/api", "/elsewhere/tools"]);
    expect(result.sections.map((section) => section.label)).toEqual(["acme", "api", "tools"]);
    expect(result.selected?.cwd).toBe("/acme");
  });

  it("keeps the picked member listed after its changes clear", () => {
    const result = umbrellaDiffSections({
      rootCwd: "/acme",
      rootLabel: "acme",
      rootIsRepo: true,
      members,
      statuses: [clean, clean, null],
      selectedMemberPath: "/acme/web",
    });
    expect(sectionPaths(result)).toEqual([null, "/acme/web"]);
    expect(result.selected?.cwd).toBe("/acme/web");
  });

  it("falls back to the root when the picked path is no longer a member", () => {
    const result = umbrellaDiffSections({
      rootCwd: "/acme",
      rootLabel: "acme",
      rootIsRepo: true,
      members,
      statuses: [clean, clean, clean],
      selectedMemberPath: "/acme/removed",
    });
    expect(sectionPaths(result)).toEqual([null]);
    expect(result.selected?.memberPath).toBeNull();
  });

  it("leaves out a root that is not a repository and still shows a member", () => {
    const withChanges = umbrellaDiffSections({
      rootCwd: "/acme",
      rootLabel: "acme",
      rootIsRepo: false,
      members,
      statuses: [clean, dirty, null],
      selectedMemberPath: null,
    });
    expect(sectionPaths(withChanges)).toEqual(["/acme/web"]);
    expect(withChanges.selected?.cwd).toBe("/acme/web");

    const allClean = umbrellaDiffSections({
      rootCwd: "/acme",
      rootLabel: "acme",
      rootIsRepo: false,
      members,
      statuses: [clean, { isRepo: false, hasWorkingTreeChanges: true }, null],
      selectedMemberPath: null,
    });
    expect(sectionPaths(allClean)).toEqual(["/acme/api"]);
  });
});
