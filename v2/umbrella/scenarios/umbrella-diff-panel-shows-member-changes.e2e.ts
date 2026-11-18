// Evidence scenario for the umbrella-projects PR. Not committed: proofs upload it instead.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "e2e";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const author = ["-c", "user.name=Scenario", "-c", "user.email=scenario@example.invalid"];

/** A plain folder holding several repositories, like a client project with one folder per area. */
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
  repo("storefront", { "README.md": "# Storefront\n", "src/price.ts": "export const price = 10;\n" });
  repo("api", { "README.md": "# API\n", "routes.txt": "GET /products\n" });
  repo("dev-setup", { "README.md": "# Dev setup\n" });
  mkdirSync(join(root, "copy"), { recursive: true });
  writeFileSync(join(root, "copy", "spring-launch.md"), "Spring launch draft\n");
  // Uncommitted work in two of the three repositories.
  writeFileSync(join(root, "storefront", "src", "price.ts"), "export const price = 12;\n");
  writeFileSync(join(root, "api", "routes.txt"), "GET /products\nGET /products/:id\n");
  return root;
}

/** True when the control is on screen, so the base commit's missing UI is a capture, not a stop. */
const present = async (locator: { count: () => Promise<number> }) => (await locator.count()) > 0;

/** Waits up to `ms` for a control the base commit does not have, without failing there. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 600));

async function appears(locator: { count: () => Promise<number> }, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await present(locator)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

test(
  "The diff panel of a folder of repositories offers an umbrella and shows each member's changes",
  WEB,
  async ({ t3, app, screen }) => {
    const { cli } = makeState(T3_HOME);
    const root = seedUmbrella();
    await runPromise(cli(["project", "add", root, "--title", "northwind"]));
    try {
      const thread = await t3.thread({ project: root, title: "Spring launch", messages: ["first"] });
      await t3.open(thread);
      await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible();

      await screen.getByRole("button", "Toggle right panel").tap();
      const diffTab = screen.getByText("Diff", { exact: true });
      if (await present(diffTab)) await diffTab.first().tap();
      await settle();
      await app.screenshot("diff-panel-on-open");

      const useAsUmbrella = screen.getByRole("button", "Use as umbrella");
      if (await appears(useAsUmbrella, 20_000)) {
        await settle();
        await app.screenshot("diff-panel-umbrella-prompt");
        await useAsUmbrella.tap();
        await expect(screen.getByRole("alertdialog")).toBeVisible();
        await settle();
        await app.screenshot("umbrella-confirmation");
        await screen.getByRole("alertdialog").getByRole("button", "Confirm").tap();
        await appears(screen.getByRole("tab", "storefront"), 30_000);
      } else {
        await app.screenshot("diff-panel-umbrella-prompt");
      }
      await settle();
      await app.screenshot("diff-panel-member-tabs");

      await expect(screen.getByRole("tab", "storefront")).toBeVisible({ timeout: 30_000 });
      await expect(screen.getByRole("tab", "api")).toBeVisible();
      await expect(screen.getByRole("tab", "dev-setup")).toHaveCount(0);
    } finally {
      await runPromise(cli(["project", "remove", root, "--force"]));
    }
  },
);
