import { describe, expect, it } from "vitest";
import { tokenStatus, validateTokenDraft } from "./TokenGovernance.tsx";
import type { Token } from "./types.ts";

const token = (patch: Partial<Token> = {}): Token => ({
  id: "token",
  name: "SDK",
  preview: "dg_test",
  scopes: ["chat:write"],
  createdAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  version: 1,
  rpmLimit: null,
  burstLimit: null,
  accessMode: "inherit",
  rotatedFromTokenId: null,
  replacedByTokenId: null,
  overlapEndsAt: null,
  rotationFamilyId: "family",
  rotationGeneration: 0,
  ...patch,
});

describe("token governance validation", () => {
  it("preserves inherited limits and validates explicit bursts", () => {
    expect(validateTokenDraft({
      name: "Local SDK",
      scopes: ["chat:write"],
      expiresAt: "",
      rpmLimit: "",
      burstLimit: "",
    })).toMatchObject({ input: { rpmLimit: null, burstLimit: null } });
    expect(validateTokenDraft({
      name: "Local SDK",
      scopes: ["chat:write"],
      expiresAt: "",
      rpmLimit: "10",
      burstLimit: "11",
    })).toEqual({ error: "Burst requests cannot exceed requests per minute." });
  });

  it("requires a name, scope, future expiry, and bounded integer limits", () => {
    expect(validateTokenDraft({
      name: "",
      scopes: [],
      expiresAt: "",
      rpmLimit: "0",
      burstLimit: "",
    })).toEqual({ error: "Enter a token name." });
    expect(validateTokenDraft({
      name: "Expired",
      scopes: ["models:read"],
      expiresAt: "2020-01-01T00:00",
      rpmLimit: "60",
      burstLimit: "5",
    })).toEqual({ error: "Expiration must be in the future." });
  });

  it("moves an overlapping predecessor to replaced exactly at its cutoff", () => {
    const cutoff = Date.parse("2026-01-01T00:05:00.000Z");
    const rotating = token({
      replacedByTokenId: "replacement",
      overlapEndsAt: new Date(cutoff).toISOString(),
    });
    expect(tokenStatus(rotating, cutoff - 1)).toBe("Overlap active");
    expect(tokenStatus(rotating, cutoff)).toBe("Replaced");
    expect(tokenStatus(token({ expiresAt: new Date(cutoff).toISOString() }), cutoff)).toBe(
      "Expired",
    );
    expect(tokenStatus(token({ revokedAt: new Date(cutoff - 1).toISOString() }), cutoff)).toBe(
      "Revoked",
    );
  });
});
