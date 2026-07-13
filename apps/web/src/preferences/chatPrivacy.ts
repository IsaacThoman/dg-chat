import type { UserPreferences } from "../types.ts";

export function temporaryChatUntilPreferencesResolve(
  demoMode: boolean,
  preferences?: Pick<UserPreferences, "saveHistory">,
): boolean {
  return demoMode ? false : preferences?.saveHistory !== true;
}

export function historyPreferenceWarning(demoMode: boolean, preferencesFailed: boolean): string {
  return !demoMode && preferencesFailed
    ? "Preferences are unavailable. New chats are temporary until they recover."
    : "";
}
