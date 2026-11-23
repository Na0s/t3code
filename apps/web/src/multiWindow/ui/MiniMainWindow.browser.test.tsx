import "../../index.css";

import type { DesktopOpenWindow, DesktopUpdateState } from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { APP_DISPLAY_NAME } from "../../branding";
import {
  CLAUDE,
  CLAUDE_UNREADABLE,
  CODEX,
  FIXTURE_NOW,
  openWindow,
  presentations,
  projectsFor,
  PULL_REQUESTS,
  UPDATE_AVAILABLE,
} from "./mini.fixtures";
import { MiniPanel } from "./MiniMainWindow";
import { MiniPullRequestList } from "./MiniPullRequests";
import { MiniUpdate } from "./MiniUpdate";
import { MiniUsageSection } from "./MiniUsage";
import { MiniWindows } from "./MiniWindows";

const mocks = vi.hoisted(() => ({ update: null as DesktopUpdateState | null }));
vi.mock("../../state/desktopUpdate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/desktopUpdate")>()),
  useDesktopUpdateState: () => mocks.update,
}));

const WINDOWS = [
  openWindow(2, "Client work", "Rate limit review - Client work", {
    projectScopeKeys: ["Northwind"],
  }),
  openWindow(3, "Window 3", "Filter envelope - Window 3", { profileId: null, focused: true }),
  openWindow(4, "Idle", `${APP_DISPLAY_NAME} - Idle`),
];

const makeActions = () => ({
  search: vi.fn(),
  expand: vi.fn(),
  newWindow: vi.fn(),
  focusWindow: vi.fn(),
  openPullRequest: vi.fn(),
});

interface PanelOptions {
  readonly usage?: LimitPresentations;
  readonly windows?: readonly DesktopOpenWindow[] | null;
  readonly multiWindowEnabled?: boolean;
  readonly pullRequestsSupported?: boolean;
}

function Panel({
  usage = presentations([CLAUDE, CODEX]),
  windows = WINDOWS,
  multiWindowEnabled = true,
  pullRequestsSupported = true,
  actions,
}: PanelOptions & { readonly actions: ReturnType<typeof makeActions> }) {
  return (
    <MiniPanel
      pullRequestsSupported={pullRequestsSupported}
      updateAvailable={mocks.update !== null}
      onSearch={actions.search}
      onExpand={actions.expand}
      onNewWindow={multiWindowEnabled ? actions.newWindow : undefined}
      tabs={{
        windows: (
          <MiniWindows
            windows={windows}
            projectsFor={projectsFor}
            onFocusWindow={actions.focusWindow}
          />
        ),
        pullRequests: (
          <MiniPullRequestList
            entries={PULL_REQUESTS}
            error={null}
            onOpen={actions.openPullRequest}
          />
        ),
        usage: <MiniUsageSection presentations={usage} now={FIXTURE_NOW} />,
        update: <MiniUpdate />,
      }}
    />
  );
}

async function renderPanel(options: PanelOptions = {}) {
  await page.viewport(320, 184);
  const actions = makeActions();
  const screen = await render(<Panel {...options} actions={actions} />);
  const openTab = (name: string) => screen.getByRole("button", { name, exact: true }).click();
  return { screen, actions, openTab };
}

const TAB_REGIONS = ["Windows", "Pull requests", "Usage", "Update"];

describe("MiniPanel", () => {
  it("opens on Usage and shows one tab's content at a time", async () => {
    mocks.update = UPDATE_AVAILABLE;
    const { screen, openTab } = await renderPanel();
    await using _screen = screen;

    await expect.element(screen.getByText("62%")).toBeVisible();
    expect(document.documentElement.scrollWidth).toBe(320);
    for (const tab of ["Windows", "Pull requests", "Update", "Usage"]) {
      await openTab(tab);
      await expect
        .element(screen.getByRole("button", { name: tab, exact: true }))
        .toHaveAttribute("aria-current", "page");
      await expect.element(screen.getByRole("region", { name: tab })).toBeVisible();
      for (const other of TAB_REGIONS) {
        if (other !== tab) expect(screen.getByRole("region", { name: other }).query()).toBeNull();
      }
    }
  });

  it("puts the tabs at the left of the top bar and Search, New Window and Expand at its right", async () => {
    const { screen, actions } = await renderPanel();
    await using _screen = screen;

    const left = (name: string) =>
      screen.getByRole("button", { name, exact: true }).element().getBoundingClientRect();
    expect(left("Windows").left).toBeLessThan(left("Update").left);
    expect(left("Update").right).toBeLessThan(left("Search").left);
    expect(left("Search").right).toBeLessThan(left("New Window").left);
    expect(left("New Window").right).toBeLessThan(left("Expand").left);
    // Flush with the panel's right edge, inside its content inset.
    expect(320 - left("Expand").right).toBeLessThanOrEqual(12);
    for (const [name, action] of [
      ["Search", actions.search],
      ["New Window", actions.newWindow],
      ["Expand", actions.expand],
    ] as const) {
      const button = screen.getByRole("button", { name });
      await expect.element(button).toHaveTextContent("");
      await button.click();
      expect(action).toHaveBeenCalledOnce();
    }
  });

  it("shows Claude's and OpenAI's limits together at the panel's default size", async () => {
    const { screen } = await renderPanel();
    await using _screen = screen;

    await expect.element(screen.getByText("Claude · Max")).toBeInViewport();
    await expect.element(screen.getByText("Codex · ChatGPT Pro 100 Subscription")).toBeInViewport();
    for (const percent of ["62%", "41%", "6%", "78%"]) {
      await expect.element(screen.getByText(percent, { exact: true })).toBeInViewport();
    }
    const viewport = screen.container.querySelector("[data-slot=scroll-area-viewport]")!;
    expect(viewport.scrollHeight).toBe(viewport.clientHeight);
  });

  it("hides New Window while multiple windows are off, and PRs where no server supports them", async () => {
    const { screen } = await renderPanel({
      multiWindowEnabled: false,
      pullRequestsSupported: false,
    });
    await using _screen = screen;
    await expect.element(screen.getByRole("button", { name: "Expand" })).toBeVisible();
    expect(screen.getByRole("button", { name: "New Window" }).query()).toBeNull();
    expect(screen.getByRole("button", { name: "Pull requests" }).query()).toBeNull();
  });

  it("lists windows as cards: project filter and state, then name, then what the window shows", async () => {
    const { screen, actions, openTab } = await renderPanel();
    await using _screen = screen;
    await openTab("Windows");

    const saved = screen.getByRole("button", { name: /Client work/ });
    await expect.element(saved).toHaveTextContent("NWNorthwindSavedClient workRate limit review");
    const focused = screen.getByRole("button", { name: /Window 3/ });
    await expect.element(focused).toHaveTextContent("All projectsFocusedWindow 3Filter envelope");
    await expect.element(focused).toHaveAttribute("aria-current", "true");
    // A window with no thread open is titled with the app's name, which says nothing.
    await expect
      .element(screen.getByRole("button", { name: /Idle/ }))
      .toHaveTextContent("All projectsSavedIdle");
    await saved.click();
    expect(actions.focusWindow).toHaveBeenCalledWith(2);
  });

  it("keeps both bars on screen and scrolls only the tab when its list is long", async () => {
    const { screen, openTab } = await renderPanel({
      windows: Array.from({ length: 14 }, (_, index) =>
        openWindow(
          10 + index,
          `Northwind storefront and checkout redesign ${index + 1} (Q4 holiday freeze)`,
          "Investigate why the dungeon lighting pass flickers on integrated GPUs",
          { projectScopeKeys: ["Northwind", "Dungeon", "Synth"] },
        ),
      ),
    });
    await using _screen = screen;
    await openTab("Windows");

    for (const name of ["Search", "Expand", "New Window", "Windows", "Update"]) {
      await expect.element(screen.getByRole("button", { name, exact: true })).toBeInViewport();
    }
    await expect.element(screen.getByRole("button", { name: /redesign 1 / })).toBeInViewport();
    await expect.element(screen.getByRole("button", { name: /redesign 14 / })).not.toBeInViewport();
    expect(document.documentElement.scrollWidth).toBe(320);
    expect(document.documentElement.scrollHeight).toBe(184);
    const viewport = screen.container.querySelector("[data-slot=scroll-area-viewport]")!;
    expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
    expect(viewport.scrollWidth).toBe(viewport.clientWidth);
  });

  it("says when Usage has no limits, and why", async () => {
    const { screen } = await renderPanel({ usage: presentations([CLAUDE_UNREADABLE]) });
    await using _screen = screen;
    await expect.element(screen.getByText("Usage unavailable")).toBeVisible();
    await expect
      .element(screen.getByText("Claude: Could not read limits. Sign in again."))
      .toBeVisible();
  });

  it("PRs opens a pull request on its host", async () => {
    const { screen, actions, openTab } = await renderPanel();
    await using _screen = screen;
    await openTab("Pull requests");

    await expect.element(screen.getByLabelText("Some checks were not successful")).toBeVisible();
    await screen.getByRole("button", { name: /Rate limit the checkout webhook/ }).click();
    expect(actions.openPullRequest).toHaveBeenCalledWith(PULL_REQUESTS[0]!.url);
  });

  it("Update names the running version and where its update stands", async () => {
    mocks.update = UPDATE_AVAILABLE;
    const { screen, openTab } = await renderPanel();
    await using _screen = screen;
    await openTab("Update");

    const update = screen.getByRole("region", { name: "Update" });
    await expect.element(update.getByText(/0\.0\.50$/)).toBeVisible();
    await expect
      .element(update.getByRole("status"))
      .toHaveTextContent("Update 0.0.51 ready to download");
  });
});
