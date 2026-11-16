import type { DesktopWindowCloseDecision } from "@t3tools/contracts";

export const WINDOW_PROFILE_NAME_MAX_LENGTH = 80;

/** The trimmed name, or null when the desktop shell would reject it. */
export function normalizeWindowProfileName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > WINDOW_PROFILE_NAME_MAX_LENGTH) return null;
  return trimmed;
}

export type WindowCloseChoice = DesktopWindowCloseDecision["action"];

/** Null when Save has no usable name, so the prompt stays open. */
export function windowCloseDecision(
  choice: WindowCloseChoice,
  name: string,
): DesktopWindowCloseDecision | null {
  if (choice !== "save") return { action: choice };
  const normalized = normalizeWindowProfileName(name);
  return normalized === null ? null : { action: "save", name: normalized };
}

// Generated theme ids never contain a colon.
const FOLLOW_MAIN_WINDOW_THEME = ":follow-main-window";

/** Select values cannot be null, so "follow the main window" gets a reserved value. */
export function themeSelectValue(theme: string | null): string {
  return theme ?? FOLLOW_MAIN_WINDOW_THEME;
}

export function themeFromSelectValue(value: string): string | null {
  return value === FOLLOW_MAIN_WINDOW_THEME ? null : value;
}
