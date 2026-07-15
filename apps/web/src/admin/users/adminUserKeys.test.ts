import { describe, expect, it } from "vitest";
import { adminUserKeys } from "./adminUserKeys.ts";

describe("admin user query keys", () => {
  it("keeps every user resource beneath one invalidation prefix", () => {
    expect(adminUserKeys.all).toEqual(["admin-users"]);
    expect(adminUserKeys.detail("user-a").slice(0, 1)).toEqual(adminUserKeys.all);
    expect(adminUserKeys.sessions("user-a", {}).slice(0, 3)).toEqual(
      adminUserKeys.detail("user-a"),
    );
    expect(adminUserKeys.tokens("user-a", {}, null).slice(0, 3)).toEqual(
      adminUserKeys.detail("user-a"),
    );
    expect(adminUserKeys.ledger("user-a", {}, null).slice(0, 3)).toEqual(
      adminUserKeys.detail("user-a"),
    );
  });

  it("isolates users, filters, limits, and pagination cursors", () => {
    expect(adminUserKeys.sessions("user-a", {})).not.toEqual(
      adminUserKeys.sessions("user-b", {}),
    );
    expect(adminUserKeys.tokens("user-a", { state: "active", limit: 25 }, "one")).not.toEqual(
      adminUserKeys.tokens("user-a", { state: "active", limit: 50 }, "one"),
    );
    expect(adminUserKeys.ledger("user-a", { kind: "grant" }, "one")).not.toEqual(
      adminUserKeys.ledger("user-a", { kind: "grant" }, "two"),
    );
  });

  it("canonicalizes equivalent flat filter objects and omits undefined values", () => {
    expect(adminUserKeys.directory({ state: "active", role: "admin", ignored: undefined }))
      .toEqual(adminUserKeys.directory({ role: "admin", state: "active" }));
    const source = ["active", "expired"] as const;
    const key = adminUserKeys.tokens("user-a", { states: source });
    expect(key[4]).toEqual({ states: ["active", "expired"] });
    expect(Object.isFrozen(key[4])).toBe(true);
    expect(Object.isFrozen((key[4] as { states: readonly string[] }).states)).toBe(true);
  });
});
