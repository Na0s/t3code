// Evidence scenario for the umbrella-projects PR. Not committed: proofs upload it instead.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "e2e";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const author = ["-c", "user.name=Scenario", "-c", "user.email=scenario@example.invalid"];

function seedUmbrella(): string {
  // Outside the checkout: an umbrella refuses a folder inside another repository.
  const root = join(mkdtempSync(join(tmpdir(), "t3-umbrella-")), "northwind");
  const repo = (name: string) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), `# ${name}\n`);
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: dir });
    execFileSync("git", ["add", "--all"], { cwd: dir });
    execFileSync("git", [...author, "commit", "--quiet", "-m", "Initial commit"], { cwd: dir });
  };
  for (const name of ["storefront", "api", "dev-setup"]) repo(name);
  mkdirSync(join(root, "copy"), { recursive: true });
  writeFileSync(join(root, "copy", "spring-launch.md"), "Spring launch draft\n");
  return root;
}

const present = async (locator: { count: () => Promise<number> }) => (await locator.count()) > 0;
const settle = () => new Promise((resolve) => setTimeout(resolve, 600));
async function appears(locator: { count: () => Promise<number> }, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await present(locator)) return true;
    await settle();
  }
  return false;
}

test(
  "Turning a folder into an umbrella folds its member projects into its sidebar group",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const { cli } = makeState(T3_HOME);
    const root = seedUmbrella();
    const api = join(root, "api");
    await runPromise(cli(["project", "add", root, "--title", "northwind"]));
    // The user already had the api repository as its own project.
    await runPromise(cli(["project", "add", api, "--title", "api"]));
    try {
      await t3.thread({ project: root, title: "Spring launch copy", messages: ["first"] });
      await t3.thread({ project: api, title: "Fix product route", messages: ["first"] });

      await t3.open("/");
      await appears(screen.getByText("Fix product route"), 30_000);
      await settle();
      await app.screenshot("sidebar-separate-projects");

      await t3.open("/settings/projects");
      await screen.getByText("All projects", { exact: true }).first().tap();
      await settle();
      await screen.getByRole("menuitemradio", /northwind/).first().tap();
      const toggle = screen.getByRole("switch", "Use as umbrella");
      await appears(toggle, 15_000);
      await settle();
      await app.screenshot("project-settings");
      if (await present(toggle)) {
        await toggle.first().tap();
        await expect(screen.getByRole("alertdialog")).toBeVisible();
        await screen.getByRole("alertdialog").getByRole("button", "Confirm").tap();
        await appears(screen.getByText("Found in folder"), 15_000);
        await settle();
        await app.screenshot("project-settings-umbrella-on");
      }

      await t3.open("/");
      await appears(screen.getByText(/·\s*api/), 15_000);
      await settle();
      await app.screenshot("sidebar-folded");

      await browser.keyboard.press("Control+k");
      await settle();
      await browser.keyboard.type("umbrella");
      await settle();
      await app.screenshot("command-palette");
      await browser.keyboard.press("Escape");

      await expect(screen.getByText(/·\s*api/).first()).toBeVisible();
    } finally {
      await runPromise(cli(["project", "remove", api, "--force"]));
      await runPromise(cli(["project", "remove", root, "--force"]));
    }
  },
);
