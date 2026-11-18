import "../../index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { MiniPanel } from "./MiniMainWindow";
import {
  CLAUDE,
  CLAUDE_UNREADABLE,
  CODEX,
  FIXTURE_NOW,
  openWindow,
  presentations,
  provider,
  usageWindow,
} from "./miniUsage.fixtures";
import { deriveMiniUsage, type MiniUsagePresentations } from "./miniUsage.logic";

const LONG_TITLE =
  "Investigate why the dungeon lighting pass flickers on integrated GPUs after the shader refactor";

async function renderPanel(
  usage: MiniUsagePresentations,
  windows: Parameters<typeof MiniPanel>[0]["windows"],
) {
  await page.viewport(320, 460);
  const onFocusWindow = vi.fn();
  const screen = await render(
    <MiniPanel
      usage={deriveMiniUsage(usage, FIXTURE_NOW)}
      now={FIXTURE_NOW}
      refreshing={false}
      windows={windows}
      onRefresh={() => {}}
      onOpenExternal={() => {}}
      onExpand={() => {}}
      onNewWindow={() => {}}
      onFocusWindow={onFocusWindow}
    />,
  );
  return { screen, onFocusWindow };
}

const top = (element: Element) => element.getBoundingClientRect().top;

describe("MiniPanel", () => {
  it("leads with usage and lists the other windows below it", async () => {
    const { screen, onFocusWindow } = await renderPanel(presentations([CLAUDE, CODEX]), [
      openWindow(2, "Northwind", "Rate limit review"),
      openWindow(3, "Window 2", "Filter envelope", { profileId: null }),
    ]);
    await using _screen = screen;

    const usage = screen.getByRole("region", { name: "Usage" });
    const windows = screen.getByRole("region", { name: "Windows" });
    await expect.element(usage.getByText("62% left")).toBeVisible();
    await expect.element(usage.getByText("resets in 42m")).toBeVisible();
    await expect.element(usage.getByText("Updated 4m ago")).toBeVisible();
    expect(top(usage.element())).toBeLessThan(top(windows.element()));

    await expect.element(windows.getByText("Unsaved")).toBeVisible();
    await windows.getByRole("button", { name: /Northwind/ }).click();
    expect(onFocusWindow).toHaveBeenCalledWith(2);
  });

  it("keeps usage, the window list and both actions on screen when every list is long", async () => {
    const { screen } = await renderPanel(
      presentations([
        CLAUDE,
        CODEX,
        provider("cursor", {
          windows: [usageWindow("apiPercentUsed", "monthly", "API", 41, 300, 720)],
        }),
        provider("antigravity", {
          windows: [
            usageWindow("gemini-3-pro-5h", "session", "Gemini 3 Pro (High) · 5h", 12, 4, 5),
          ],
        }),
      ]),
      [
        openWindow(2, "Northwind storefront and checkout redesign (Q4 holiday freeze)", LONG_TITLE),
        ...Array.from({ length: 14 }, (_, index) =>
          openWindow(10 + index, `Client ${index + 1}`, LONG_TITLE),
        ),
      ],
    );
    await using _screen = screen;

    for (const name of ["Expand", "New Window", "Refresh limits"]) {
      await expect.element(screen.getByRole("button", { name })).toBeInViewport();
    }
    await expect.element(screen.getByText("62% left")).toBeInViewport();
    await expect
      .element(screen.getByRole("button", { name: /Northwind storefront/ }))
      .toBeInViewport();
    await expect.element(screen.getByRole("button", { name: /Client 14/ })).not.toBeInViewport();
    expect(document.documentElement.scrollWidth).toBe(320);
    expect(document.documentElement.scrollHeight).toBe(460);
    const viewports = screen.container.querySelectorAll("[data-slot=scroll-area-viewport]");
    expect(viewports).toHaveLength(2);
    for (const viewport of viewports) {
      expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
      expect(viewport.scrollWidth).toBe(viewport.clientWidth);
    }
  });

  it("says why there are no limits: still loading, none reported, or unavailable", async () => {
    const { screen } = await renderPanel(presentations(null, "connecting"), null);
    await using _screen = screen;
    await expect
      .element(screen.getByRole("status", { name: "Loading usage limits" }))
      .toBeVisible();

    const rerender = (usage: MiniUsagePresentations) =>
      screen.rerender(
        <MiniPanel
          usage={deriveMiniUsage(usage, FIXTURE_NOW)}
          now={FIXTURE_NOW}
          refreshing={false}
          windows={[]}
          onRefresh={() => {}}
          onOpenExternal={() => {}}
          onExpand={() => {}}
          onNewWindow={() => {}}
          onFocusWindow={() => {}}
        />,
      );
    await rerender(presentations([]));
    await expect.element(screen.getByText(/No provider reports plan limits yet/)).toBeVisible();
    await expect.element(screen.getByText("No other windows are open.")).toBeVisible();

    await rerender(presentations([CLAUDE_UNREADABLE]));
    await expect.element(screen.getByText("Limits unavailable")).toBeVisible();
    await expect
      .element(screen.getByText("Claude: Could not read limits. Sign in again."))
      .toBeVisible();
  });
});
