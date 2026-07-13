export type ThemePreference = "light" | "dark" | "system";

export function resolvedTheme(
  preference: ThemePreference,
  systemDark: boolean,
): "light" | "dark" {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

export function applyTheme(
  preference: ThemePreference,
  root: HTMLElement = document.documentElement,
  systemDark = globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
) {
  root.dataset.themePreference = preference;
  root.dataset.theme = resolvedTheme(preference, systemDark);
  root.style.colorScheme = resolvedTheme(preference, systemDark);
}

export function watchSystemTheme(
  preference: ThemePreference,
  apply: (systemDark: boolean) => void,
): () => void {
  if (preference !== "system" || !globalThis.matchMedia) return () => undefined;
  const query = globalThis.matchMedia("(prefers-color-scheme: dark)");
  const update = () => apply(query.matches);
  query.addEventListener?.("change", update);
  return () => query.removeEventListener?.("change", update);
}
