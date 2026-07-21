export type ThemePreference = "light" | "dark" | "system";

export function resolvedTheme(
  preference: ThemePreference,
  systemDark: boolean,
): "light" | "dark" {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

export function themeColor(theme: "light" | "dark"): string {
  return theme === "dark" ? "#171715" : "#f7f7f5";
}

export function applyTheme(
  preference: ThemePreference,
  root: HTMLElement = document.documentElement,
  systemDark = globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
) {
  const theme = resolvedTheme(preference, systemDark);
  root.dataset.themePreference = preference;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.ownerDocument?.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
    "content",
    themeColor(theme),
  );
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
