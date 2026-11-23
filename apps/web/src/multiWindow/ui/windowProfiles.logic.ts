export const WINDOW_PROFILE_NAME_MAX_LENGTH = 80;

/** The trimmed name, or null when the desktop shell would reject it. */
export function normalizeWindowProfileName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > WINDOW_PROFILE_NAME_MAX_LENGTH) return null;
  return trimmed;
}
