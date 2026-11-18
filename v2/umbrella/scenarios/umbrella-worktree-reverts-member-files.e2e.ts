// Evidence scenario for the umbrella-projects PR. Not committed: proofs upload it instead.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "e2e";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const author = ["-c", "user.name=Scenario", "-c", "user.email=scenario@example.invalid"];

function seedUmbrella(): string {
  // Outside the checkout: an umbrella refuses a folder inside another repository.
  const root = join(mkdtempSync(join(tmpdir(), "t3-umbrella-")), "northwind");
  const repo = (name: string, files: Record<string, string>) => {
    const dir = join(root, name);
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: dir });
    execFileSync("git", ["add", "--all"], { cwd: dir });
    execFileSync("git", [...author, "commit", "--quiet", "-m", "Initial commit"], { cwd: dir });
  };
  repo("storefront", { "README.md": "# Storefront\n" });
  repo("api", { "README.md": "# API\n" });
  mkdirSync(join(root, "copy"), { recursive: true });
  writeFileSync(join(root, "copy", "spring-launch.md"), "Spring launch draft\n");
  return root;
}

const present = async (locator: { count: () => Promise<number> }) => (await locator.count()) > 0;
async function appears(locator: { count: () => Promise<number> }, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await present(locator)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 600));

test(
  "Revert files too restores every member repository of an umbrella worktree",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const { cli } = makeState(T3_HOME);
    const root = seedUmbrella();
    await runPromise(cli(["project", "add", root, "--title", "northwind"]));
    try {
      // The scenario home sits inside this checkout; keep the thread's worktrees out of it, as
      // ~/.t3/worktrees is for a user.
      const worktrees = mkdtempSync(join(tmpdir(), "t3-worktrees-"));
      const setup = await t3.thread({ project: root, title: "Setup", messages: ["first"] });
      await t3.open("/settings/worktrees");
      await screen.getByRole("textbox", "Worktree location").fill(worktrees);
      await browser.keyboard.press("Tab");
      await settle();

      // Turn the umbrella on where a user would first meet it: the diff panel's prompt.
      await t3.open(setup);
      await screen.getByRole("button", "Toggle right panel").tap();
      const diffTab = screen.getByText("Diff", { exact: true });
      if (await present(diffTab)) await diffTab.first().tap();
      const useAsUmbrella = screen.getByRole("button", "Use as umbrella");
      if (await appears(useAsUmbrella, 20_000)) {
        await useAsUmbrella.tap();
        await screen.getByRole("alertdialog").getByRole("button", "Confirm").tap();
        await appears(screen.getByRole("tab", "storefront"), 30_000);
      }

      // A worktree thread whose turn waits on a question, so edits land inside the turn.
      const launched = await runPromise(
        cli(
          [
            "thread", "start", root, "Update both READMEs", "--title", "Spring launch",
            "--provider", "devReplay", "--model", "question", "--worktree", "main",
            "--wait", "--json",
          ],
          [0, 1, 2],
        ),
      );
      if (process.env.SCENARIO_DEBUG_FILE) {
        writeFileSync(process.env.SCENARIO_DEBUG_FILE, JSON.stringify(launched, null, 2));
      }
      const threadId = /"threadId"\s*:\s*"([^"]+)"/.exec(launched.stdout)?.[1];
      const shown = threadId
        ? (await runPromise(cli(["thread", "show", threadId, "--json"], [0, 1]))).stdout
        : "";
      const worktreePath = /"worktreePath"\s*:\s*"([^"]+)"/.exec(shown)?.[1];
      const memberReadme = (member: string) => join(worktreePath ?? "/nonexistent", member, "README.md");
      let turnDiffShown = false;
      if (threadId === undefined) {
        await app.screenshot("worktree-thread-launch");
      } else {
        for (const member of ["storefront", "api"]) {
          if (existsSync(memberReadme(member))) appendFileSync(memberReadme(member), "Spring launch\n");
        }
        await t3.open({ threadId });
        const answer = screen.getByText("Strict schemas (Recommended)", { exact: false });
        if (await appears(answer, 30_000)) {
          await app.screenshot("question-pending");
          await answer.first().tap();
          await settle();
          const submit = screen.getByRole("button", /^(Submit|Send|Continue|Answer)/);
          if (await present(submit)) await submit.first().tap();
          await app.screenshot("question-answered");
        }
        turnDiffShown = await appears(screen.getByText("2 changed files"), 30_000);
        const storefrontFolder = screen.getByText("storefront", { exact: true });
        if (turnDiffShown && (await present(storefrontFolder))) await storefrontFolder.first().tap();
        await settle();
        await app.screenshot("turn-diff");

        // A prompt sent from the CLI shows as a collapsed agent row; its actions show when it opens.
        await screen.getByText("Update both READMEs", { exact: true }).first().tap();
        await settle();
        const editFromHere = screen.getByRole("button", "Edit from here");
        if (await appears(editFromHere, 10_000)) {
          await editFromHere.first().tap();
          await expect(screen.getByRole("alertdialog")).toBeVisible();
          await settle();
          await app.screenshot("revert-dialog");
          const revertFiles = screen.getByRole("button", "Revert files too");
          if (await revertFiles.isEnabled()) await revertFiles.tap();
          // The thread rewinds to before the prompt once the restore is done.
          const deadline = Date.now() + 15_000;
          while (Date.now() < deadline && (await present(screen.getByText("2 changed files")))) {
            await settle();
          }
          await settle();
        }
        await app.screenshot("after-revert");
      }

      expect(threadId).toBeDefined();
      expect(turnDiffShown).toBe(true);
      for (const member of ["storefront", "api"]) {
        await expect.poll(() => readFileSync(memberReadme(member), "utf8")).not.toContain("Spring launch");
      }
      // The originals were never touched.
      expect(readFileSync(join(root, "storefront", "README.md"), "utf8")).toBe("# Storefront\n");
    } finally {
      await runPromise(cli(["project", "remove", root, "--force"]));
    }
  },
);
