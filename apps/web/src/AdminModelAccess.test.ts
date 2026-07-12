import { describe, expect, it } from "vitest";
import {
  policyNeedsWideningConfirmation,
  removeUserAndOwnedTokens,
  selectTokenWithOwner,
} from "./AdminModelAccess.tsx";

describe("model access policy editing", () => {
  it("couples selected tokens to their owner and removes loaded owner tokens together", () => {
    const token = { id: "token", ownerId: "owner" };
    expect(selectTokenWithOwner([], [], token)).toEqual({
      userIds: ["owner"],
      tokenIds: ["token"],
    });
    expect(removeUserAndOwnedTokens(["owner", "other"], ["token", "other-token"], "owner", [
      { tokenId: token.id, ownerId: token.ownerId },
      { tokenId: "other-token", ownerId: "other" },
    ])).toEqual({ userIds: ["other"], tokenIds: ["other-token"] });
  });

  it("requires confirmation for every access-loss or widening impact", () => {
    expect(policyNeedsWideningConfirmation({
      modelIdsBecomingPublic: [],
      tokenIdsLosingGroupAccess: [],
      tokenIdsRevertingToOwnerInheritance: [],
    })).toBe(false);
    expect(policyNeedsWideningConfirmation({
      modelIdsBecomingPublic: ["model"],
      tokenIdsLosingGroupAccess: [],
      tokenIdsRevertingToOwnerInheritance: [],
    })).toBe(true);
    expect(policyNeedsWideningConfirmation({
      modelIdsBecomingPublic: [],
      tokenIdsLosingGroupAccess: ["token"],
      tokenIdsRevertingToOwnerInheritance: [],
    })).toBe(true);
  });
});
