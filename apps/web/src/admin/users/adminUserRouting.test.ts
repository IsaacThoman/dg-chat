import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminUserDetailPath,
  adminUserTabForKey,
  adminUserTabForTargetKey,
  adminUserTabId,
  adminUserTabLabels,
  adminUserTabPanelId,
  adminUserTabs,
  authenticatedAdminDestination,
  consumeAdminUserReturnPath,
  isAdminUserRouteId,
  isAdminUserTab,
  parseAdminUserDetailParams,
  parseAdminUserTab,
  storeAdminUserReturnPath,
} from "./adminUserRouting.ts";

afterEach(() => vi.unstubAllGlobals());

describe("admin user detail routing", () => {
  it("defines four stable, labeled tabs", () => {
    expect(adminUserTabs).toEqual(["account", "sessions", "tokens", "billing"]);
    expect(adminUserTabs.map((tab) => adminUserTabLabels[tab])).toEqual([
      "Account",
      "Sessions",
      "API tokens",
      "Billing",
    ]);
    expect(adminUserTabs.every(isAdminUserTab)).toBe(true);
  });

  it("validates tabs and canonical UUID user IDs", () => {
    expect(parseAdminUserTab("sessions")).toBe("sessions");
    expect(parseAdminUserTab("../billing")).toBe("account");
    expect(parseAdminUserTab(undefined, "billing")).toBe("billing");
    expect(isAdminUserRouteId("019f4a1f-4ea2-7492-a8fc-eb07d9be43f0")).toBe(true);
    for (
      const invalid of [
        "",
        " user",
        "user ",
        ".",
        "..",
        "a/b",
        "a\\b",
        "x\n",
        "\ud800",
        "x".repeat(201),
        "user:one",
        "019f4a1f4ea27492a8fceb07d9be43f0",
        "019f4a1f-4ea2-0492-a8fc-eb07d9be43f0",
        "019f4a1f-4ea2-7492-78fc-eb07d9be43f0",
      ]
    ) {
      expect(isAdminUserRouteId(invalid), invalid).toBe(false);
    }
  });

  it("builds encoded paths and strictly parses detail params", () => {
    const userId = "019f4a1f-4ea2-7492-a8fc-eb07d9be43f0";
    expect(adminUserDetailPath(userId, "tokens")).toBe(`/admin/users/${userId}/tokens`);
    expect(parseAdminUserDetailParams({ userId, tab: "billing" })).toEqual({
      userId,
      tab: "billing",
    });
    expect(parseAdminUserDetailParams({ userId, tab: "unknown" })).toBeNull();
    expect(parseAdminUserDetailParams({ userId: "../one", tab: "account" })).toBeNull();
    expect(() => adminUserDetailPath("../one", "account")).toThrow(TypeError);
  });

  it("provides stable tab and panel IDs for aria relationships", () => {
    const userId = "019f4a1f-4ea2-7492-a8fc-eb07d9be43f0";
    expect(adminUserTabId(userId, "sessions")).toBe(
      `admin-user-${userId}-sessions-tab`,
    );
    expect(adminUserTabPanelId(userId, "sessions")).toBe(
      `admin-user-${userId}-sessions-panel`,
    );
  });

  it("implements wrapping LTR and RTL keyboard navigation", () => {
    expect(adminUserTabForKey("account", "ArrowLeft")).toBe("billing");
    expect(adminUserTabForKey("billing", "ArrowRight")).toBe("account");
    expect(adminUserTabForKey("sessions", "ArrowRight")).toBe("tokens");
    expect(adminUserTabForKey("sessions", "ArrowRight", "rtl")).toBe("account");
    expect(adminUserTabForKey("sessions", "Home")).toBe("account");
    expect(adminUserTabForKey("sessions", "End")).toBe("billing");
    expect(adminUserTabForKey("sessions", "Enter")).toBeNull();
  });

  it("advances rapid key presses from the focused tab while URL state catches up", () => {
    const first = adminUserTabForTargetKey("account", "account", "ArrowRight");
    expect(first).toBe("sessions");
    const second = adminUserTabForTargetKey(first, "account", "ArrowRight");
    expect(second).toBe("tokens");
    expect(adminUserTabForTargetKey("invalid", "billing", "ArrowRight")).toBe("account");
  });

  it("stores only validated same-origin reauthentication return paths and consumes once", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const userId = "019f4a1f-4ea2-7492-a8fc-eb07d9be43f0";
    storeAdminUserReturnPath(`/admin/users/${userId}/billing?userSearch=person`);
    expect(consumeAdminUserReturnPath()).toBe(
      `/admin/users/${userId}/billing?userSearch=person`,
    );
    expect(consumeAdminUserReturnPath()).toBeNull();
    expect(() => storeAdminUserReturnPath("https://evil.example/admin/users/user/account"))
      .toThrow(TypeError);
    expect(() => storeAdminUserReturnPath("/admin/usage"))
      .toThrow(TypeError);
  });

  it("restores a validated admin route only for a full authenticated workspace", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const userId = "019f4a1f-4ea2-7492-a8fc-eb07d9be43f0";
    storeAdminUserReturnPath(`/admin/users/${userId}/tokens?userSearch=security`);
    expect(authenticatedAdminDestination("/pending")).toBe("/pending");
    expect(authenticatedAdminDestination("/")).toBe(
      `/admin/users/${userId}/tokens?userSearch=security`,
    );
    expect(authenticatedAdminDestination("/")).toBe("/");
  });
});
