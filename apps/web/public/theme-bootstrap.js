(() => {
  const root = document.documentElement;
  try {
    const saved = localStorage.getItem("dg-chat.theme");
    const preference = saved === "dark" || saved === "light" ? saved : "system";
    const systemDark = preference === "system" &&
      matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = preference === "system" ? (systemDark ? "dark" : "light") : preference;
    root.dataset.theme = theme;
    root.dataset.themePreference = preference;
    root.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      "content",
      theme === "dark" ? "#171715" : "#f7f7f5",
    );
  } catch {
    root.dataset.theme = "light";
    root.dataset.themePreference = "system";
    root.style.colorScheme = "light";
  }
})();
