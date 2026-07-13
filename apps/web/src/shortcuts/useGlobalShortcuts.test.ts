import { describe, expect, it, vi } from "vitest";
import { focusConversationSearch, mobileSidebarLayout } from "./useGlobalShortcuts.ts";

describe("desktop conversation search shortcut", () => {
  it("does not classify a persistent desktop sidebar as a mobile drawer", () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: false });
    expect(mobileSidebarLayout({ matchMedia } as Pick<typeof globalThis, "matchMedia">)).toBe(
      false,
    );
    expect(matchMedia).toHaveBeenCalledWith("(max-width: 760px)");
  });

  it("focuses desktop search without opening a modal drawer", () => {
    const openDrawer = vi.fn();
    const focus = vi.fn();
    focusConversationSearch({
      openDrawer,
      focus,
      mobile: false,
      schedule: (callback) => callback(),
    });
    expect(openDrawer).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledOnce();
  });

  it("opens the drawer at the mobile breakpoint", () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    expect(mobileSidebarLayout({ matchMedia } as Pick<typeof globalThis, "matchMedia">)).toBe(true);
  });
});
