import { msg } from "gt-i18n";

import { m } from "../i18n/messages.ts";

type DesktopWindowCloseAction =
  /** Let the window close. */
  | "close"
  /** Keep the main window's renderer running for the secondary windows it serves. */
  | "hide"
  /** Ask the renderer whether to save the unsaved window first. */
  | "prompt"
  /** A prompt is already open; the renderer's answer decides. */
  | "keep-open";

export interface DesktopWindowCloseInput {
  readonly isMain: boolean;
  readonly quitting: boolean;
  readonly saved: boolean;
  readonly secondaryWindowCount: number;
  /** A save or discard decision already approved this close. */
  readonly closeApproved: boolean;
  /** Loaded, not crashed, responsive, and listening for close requests. */
  readonly rendererCanPrompt: boolean;
  readonly promptPending: boolean;
}

export function resolveWindowCloseAction(input: DesktopWindowCloseInput): DesktopWindowCloseAction {
  if (input.quitting || input.closeApproved) return "close";
  if (input.isMain) return input.secondaryWindowCount > 0 ? "hide" : "close";
  if (input.saved || !input.rendererCanPrompt) return "close";
  return input.promptPending ? "keep-open" : "prompt";
}

/** The main window is the first window, so unsaved secondary windows count from 2. */
export function nextUnsavedWindowName(usedNames: Iterable<string>): string {
  const used = new Set(usedNames);
  for (let index = 2; ; index++) {
    const name = m(
      msg("Window {number}", {
        $context: "name of an unsaved app window",
        number: String(index),
      }),
    );
    if (!used.has(name)) return name;
  }
}

export function composeWindowTitle(input: {
  readonly rendererTitle: string;
  readonly fallbackTitle: string;
  readonly isMain: boolean;
  readonly windowName: string;
  readonly secondaryWindowCount: number;
}): string {
  const base = input.rendererTitle.trim() === "" ? input.fallbackTitle : input.rendererTitle;
  const showName = !input.isMain || input.secondaryWindowCount > 0;
  return showName ? `${base} - ${input.windowName}` : base;
}

interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const CASCADE_OFFSET_PX = 28;

/** Places a new window down and right of the window it opened from, wrapping inside that display. */
export function cascadeWindowBounds(input: {
  readonly anchor: Rectangle | null;
  readonly size: { readonly width: number; readonly height: number };
  readonly displays: readonly Rectangle[];
}): Rectangle | { readonly width: number; readonly height: number } {
  const { anchor } = input;
  if (anchor === null) return input.size;
  const display =
    input.displays.find(
      (candidate) =>
        anchor.x >= candidate.x &&
        anchor.y >= candidate.y &&
        anchor.x < candidate.x + candidate.width &&
        anchor.y < candidate.y + candidate.height,
    ) ?? input.displays[0];
  if (display === undefined) return input.size;
  const width = Math.min(input.size.width, display.width);
  const height = Math.min(input.size.height, display.height);
  let x = anchor.x + CASCADE_OFFSET_PX;
  let y = anchor.y + CASCADE_OFFSET_PX;
  if (x + width > display.x + display.width || y + height > display.y + display.height) {
    x = display.x + CASCADE_OFFSET_PX;
    y = display.y + CASCADE_OFFSET_PX;
  }
  return {
    x: Math.round(Math.min(x, display.x + display.width - width)),
    y: Math.round(Math.min(y, display.y + display.height - height)),
    width,
    height,
  };
}
