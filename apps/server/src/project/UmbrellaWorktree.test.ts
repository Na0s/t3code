// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { VcsStatusLocalResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as UmbrellaMemberIndex from "../vcs/UmbrellaMemberIndex.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { makeUmbrellaWorktrees } from "./UmbrellaWorktree.ts";
import {
  readUmbrellaWorktree,
  UMBRELLA_WORKTREE_MANIFEST_SUFFIX,
} from "./umbrellaWorktreeLayout.ts";

// The workflow service's Git calls, answered by the real driver.
const layerGitWorkflow = Layer.unwrap(
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const run = (cwd: string, args: ReadonlyArray<string>) =>
      driver.execute({ operation: "UmbrellaWorktree.test", cwd, args, allowNonZeroExit: true });
    const currentBranch = (cwd: string) =>
      run(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
      );
    return Layer.mock(GitWorkflowService.GitWorkflowService)({
      repositoryRoot: (cwd) =>
        run(cwd, ["rev-parse", "--show-toplevel"]).pipe(
          Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
        ),
      hasCommit: ({ cwd, refName }) =>
        run(cwd, ["rev-parse", "--verify", "--quiet", `${refName}^{commit}`]).pipe(
          Effect.map((result) => result.exitCode === 0),
        ),
      currentBranch,
      localStatus: ({ cwd }) =>
        currentBranch(cwd).pipe(
          Effect.map((refName) => ({ isRepo: true, refName }) as VcsStatusLocalResult),
        ),
      invalidateLocalStatus: () => Effect.void,
      createWorktree: driver.createWorktree,
      removeWorktree: driver.removeWorktree,
      pruneWorktrees: driver.pruneWorktrees,
      deleteLocalBranch: driver.deleteLocalBranch,
      renameBranch: driver.renameBranch,
      listLocalBranchNames: driver.listLocalBranchNames,
      resolvePrimaryRemoteName: driver.resolvePrimaryRemoteName,
      resolveRemoteTrackingCommit: driver.resolveRemoteTrackingCommit,
      resolveWorktreeBaseRemote: driver.resolveWorktreeBaseRemote,
      fetchWorktreeBaseCommit: driver.fetchWorktreeBaseCommit,
    });
  }),
);

const layerTest = layerGitWorkflow.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-umbrella-worktree-" })),
  Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(UmbrellaMemberIndex.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const result = yield* (yield* VcsProcess.VcsProcess).run({
      operation: "UmbrellaWorktree.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const initRepo = (cwd: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(cwd, { recursive: true });
    yield* git(cwd, ["init", "--initial-branch=main"]);
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(
      NodePath.join(cwd, "README.md"),
      `# ${NodePath.basename(cwd)}\n`,
    );
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial"]);
  });

/** A plain or Git umbrella folder holding two member repositories and a shared notes folder. */
const makeUmbrella = (rootRepository: boolean) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = NodeFS.realpathSync.native(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "umbrella-root-" }),
    );
    const outside = NodeFS.realpathSync.native(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "umbrella-outside-" }),
    );
    if (rootRepository) {
      yield* initRepo(root);
      yield* fileSystem.writeFileString(NodePath.join(root, ".gitignore"), "api/\nclients/\n");
      yield* git(root, ["add", ".gitignore"]);
      yield* git(root, ["commit", "-m", "ignore members"]);
    }
    yield* initRepo(NodePath.join(root, "api"));
    yield* initRepo(NodePath.join(root, "clients", "web"));
    yield* fileSystem.makeDirectory(NodePath.join(root, "copy"), { recursive: true });
    yield* fileSystem.writeFileString(NodePath.join(root, "copy", "brief.md"), "brief\n");
    yield* fileSystem.writeFileString(NodePath.join(root, "clients", "contacts.md"), "contacts\n");
    const adopted = NodePath.join(outside, "design");
    yield* initRepo(adopted);
    return {
      root,
      members: [
        { path: NodePath.join(root, "api"), relativePath: "api" },
        { path: NodePath.join(root, "clients", "web"), relativePath: "clients/web" },
        { path: adopted, relativePath: NodePath.relative(root, adopted) },
      ],
    };
  });

it.layer(layerTest)("UmbrellaWorktree", (it) => {
  it.effect.each([false, true])(
    "mirrors the umbrella in one thread folder when the root is a repository: %s",
    (rootRepository) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const umbrella = yield* makeUmbrella(rootRepository);
        // A T3 home inside a repository puts every thread folder inside that repository too.
        const { baseDir } = yield* ServerConfig.ServerConfig;
        if (!(yield* fileSystem.exists(NodePath.join(baseDir, ".git")))) yield* initRepo(baseDir);
        const worktrees = yield* makeUmbrellaWorktrees;
        const created = yield* worktrees.create({
          umbrellaRoot: umbrella.root,
          members: umbrella.members,
          baseRef: rootRepository ? "main" : "HEAD",
          startFromOrigin: false,
          branch: "feature/umbrella",
          flattenOnConflict: false,
          submodules: null,
        });
        const folder = created.path;
        const config = yield* ServerConfig.ServerConfig;
        assert.strictEqual(NodePath.dirname(NodePath.dirname(folder)), config.worktreesDir);
        assert.strictEqual(created.rootRepository, rootRepository);

        // Every repository is a worktree on the thread branch; the originals stay put.
        for (const [repository, relativePath] of [
          [NodePath.join(umbrella.root, "api"), "api"],
          [NodePath.join(umbrella.root, "clients", "web"), "clients/web"],
          [umbrella.members[2]!.path, "_external/design"],
          ...(rootRepository ? [[umbrella.root, ""] as const] : []),
        ] as const) {
          const checkout = relativePath === "" ? folder : NodePath.join(folder, relativePath);
          assert.strictEqual(
            yield* git(checkout, ["symbolic-ref", "--short", "HEAD"]),
            "feature/umbrella",
          );
          assert.strictEqual(yield* git(repository, ["symbolic-ref", "--short", "HEAD"]), "main");
        }

        const contacts = NodePath.join(folder, "clients", "contacts.md");
        if (rootRepository) {
          // The root's own checkout supplies its files; untracked siblings are not linked.
          assert.isFalse(yield* fileSystem.exists(NodePath.join(folder, "copy")));
          assert.isTrue(yield* fileSystem.exists(NodePath.join(folder, ".gitignore")));
        } else {
          assert.strictEqual(
            yield* fileSystem.readLink(NodePath.join(folder, "copy")),
            NodePath.join(umbrella.root, "copy"),
          );
          assert.strictEqual(
            yield* fileSystem.readLink(contacts),
            contacts.replace(folder, umbrella.root),
          );
          assert.isFalse(yield* fileSystem.exists(NodePath.join(folder, ".git")));
          // Git never finds the enclosing repository from the plain folder.
          const outer = yield* Effect.exit(git(folder, ["rev-parse", "--show-toplevel"]));
          assert.isTrue(outer._tag === "Failure");
        }

        const layout = yield* readUmbrellaWorktree(folder);
        assert.deepStrictEqual(
          layout?.members.map((member) => member.path),
          ["api", "clients/web", "_external/design"],
        );
        const index = yield* UmbrellaMemberIndex.UmbrellaMemberIndex;
        assert.deepStrictEqual(index.memberPathsWithin(NodeFS.realpathSync.native(folder)), [
          "api",
          "clients/web",
          "_external/design",
        ]);

        // Removal takes every worktree, keeps the originals and branches, and forgets the folder.
        yield* fileSystem.writeFileString(NodePath.join(folder, "api", "draft.md"), "draft\n");
        assert.isTrue(yield* worktrees.remove({ worktreePath: folder, force: true }));
        assert.isFalse(yield* fileSystem.exists(folder));
        assert.isFalse(yield* fileSystem.exists(`${folder}${UMBRELLA_WORKTREE_MANIFEST_SUFFIX}`));
        assert.deepStrictEqual(index.memberPathsWithin(folder), []);
        assert.strictEqual(
          yield* fileSystem.readFileString(NodePath.join(umbrella.root, "copy", "brief.md")),
          "brief\n",
        );
        for (const repository of [
          umbrella.root,
          ...umbrella.members.map((member) => member.path),
        ]) {
          if (repository === umbrella.root && !rootRepository) continue;
          const listed = yield* git(repository, ["worktree", "list", "--porcelain"]);
          assert.notInclude(listed, folder);
          assert.strictEqual(
            yield* git(repository, ["branch", "--list", "feature/umbrella"]),
            "feature/umbrella",
          );
        }
      }),
  );

  it.effect("recreates the missing parts of an umbrella worktree from its branch", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const umbrella = yield* makeUmbrella(false);
      const worktrees = yield* makeUmbrellaWorktrees;
      const created = yield* worktrees.create({
        umbrellaRoot: umbrella.root,
        members: umbrella.members,
        baseRef: "HEAD",
        startFromOrigin: false,
        branch: "t3code/abc12345",
        flattenOnConflict: true,
        submodules: null,
      });
      const folder = created.path;
      yield* fileSystem.writeFileString(NodePath.join(folder, "api", "work.md"), "work\n");
      yield* git(NodePath.join(folder, "api"), ["add", "work.md"]);
      yield* git(NodePath.join(folder, "api"), ["commit", "-m", "work"]);

      // Storage cleanup keeps the manifest, so the next turn rebuilds the same layout.
      yield* worktrees.remove({ worktreePath: folder, force: false, keepManifest: true });
      assert.isFalse(yield* fileSystem.exists(folder));
      assert.isTrue(
        yield* worktrees.restoreMissing({ worktreePath: folder, branch: created.branch }),
      );
      assert.strictEqual(
        yield* fileSystem.readFileString(NodePath.join(folder, "api", "work.md")),
        "work\n",
      );
      assert.isTrue(yield* fileSystem.exists(NodePath.join(folder, "_external", "design", ".git")));
      assert.strictEqual(
        yield* fileSystem.readLink(NodePath.join(folder, "copy")),
        NodePath.join(umbrella.root, "copy"),
      );

      // One member removed by hand comes back alone; a folder the agent unlinked stays unlinked.
      yield* fileSystem.remove(NodePath.join(folder, "copy"));
      yield* git(umbrella.members[1]!.path, [
        "worktree",
        "remove",
        "--force",
        NodePath.join(folder, "clients", "web"),
      ]);
      assert.isTrue(
        yield* worktrees.restoreMissing({ worktreePath: folder, branch: created.branch }),
      );
      assert.strictEqual(
        yield* git(NodePath.join(folder, "clients", "web"), ["symbolic-ref", "--short", "HEAD"]),
        created.branch,
      );
      assert.isFalse(yield* fileSystem.exists(NodePath.join(folder, "copy")));

      assert.isFalse(
        yield* worktrees.restoreMissing({ worktreePath: umbrella.root, branch: created.branch }),
      );
    }),
  );

  it.effect("renames the thread branch in every repository and rolls back a failed creation", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const umbrella = yield* makeUmbrella(true);
      const worktrees = yield* makeUmbrellaWorktrees;
      const created = yield* worktrees.create({
        umbrellaRoot: umbrella.root,
        members: umbrella.members,
        baseRef: "main",
        startFromOrigin: false,
        branch: "t3code/0011aabb",
        flattenOnConflict: true,
        submodules: null,
      });
      const renamed = yield* worktrees.renameBranch({
        worktreePath: created.path,
        oldBranch: created.branch,
        newBranch: "feature/renamed",
        exactName: true,
      });
      assert.strictEqual(renamed.branch, "feature/renamed");
      for (const relativePath of ["", "api", "clients/web", "_external/design"]) {
        assert.strictEqual(
          yield* git(NodePath.join(created.path, relativePath), [
            "symbolic-ref",
            "--short",
            "HEAD",
          ]),
          "feature/renamed",
        );
      }
      yield* worktrees.remove({
        worktreePath: created.path,
        force: true,
        deleteBranch: "feature/renamed",
      });
      assert.strictEqual(
        yield* git(umbrella.members[0]!.path, ["branch", "--list", "feature/renamed"]),
        "",
      );

      // A member that cannot take the branch undoes the worktrees made before it.
      yield* git(umbrella.members[2]!.path, ["branch", "taken"]);
      const failure = yield* Effect.flip(
        worktrees.create({
          umbrellaRoot: umbrella.root,
          members: umbrella.members,
          baseRef: "main",
          startFromOrigin: false,
          branch: "taken",
          flattenOnConflict: false,
          submodules: null,
        }),
      );
      assert.strictEqual(failure._tag, "UmbrellaWorktreeError");
      assert.strictEqual(yield* git(umbrella.root, ["branch", "--list", "taken"]), "");
      assert.strictEqual(yield* git(umbrella.members[0]!.path, ["branch", "--list", "taken"]), "");
      const config = yield* ServerConfig.ServerConfig;
      const leftovers = yield* fileSystem
        .readDirectory(NodePath.join(config.worktreesDir, NodePath.basename(umbrella.root)))
        .pipe(Effect.orElseSucceed((): string[] => []));
      assert.deepStrictEqual(leftovers, []);
    }),
  );
});
