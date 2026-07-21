import { describe, expect, it } from "vitest";
import {
  actionableWideningImpact,
  policyNeedsWideningConfirmation,
  publicModelLabels,
  refreshWideningConfirmation,
  removeUserAndOwnedTokens,
  selectTokenWithOwner,
  wideningAcknowledgementRequired,
} from "./AdminModelAccess.tsx";
import { ApiError } from "./api.ts";
import type { AccessGroupPolicyImpact } from "./types.ts";

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

  it("distinguishes stale widening acknowledgement from unrelated conflicts", () => {
    expect(wideningAcknowledgementRequired(
      new ApiError(
        409,
        "model_access_widening_acknowledgement_required",
        "review exact models",
      ),
    )).toBe(true);
    expect(wideningAcknowledgementRequired(
      new ApiError(409, "version_conflict", "changed"),
    )).toBe(false);
  });

  it("resolves exact public model identities for widening confirmation", () => {
    expect(publicModelLabels(["model-2", "missing"], [{
      id: "model-2",
      displayName: "Reasoning Large",
      publicModelId: "vendor/reasoning-large",
    }])).toEqual([
      {
        id: "model-2",
        displayName: "Reasoning Large",
        publicModelId: "vendor/reasoning-large",
      },
      { id: "missing", displayName: "Unknown model", publicModelId: "missing" },
    ]);
  });

  it("makes a stale group-save acknowledgement non-actionable until re-preview completes", async () => {
    const refreshed = {
      modelIdsBecomingPublic: ["model-new"],
      tokenIdsLosingGroupAccess: [],
      tokenIdsRevertingToOwnerInheritance: [],
    };
    let resolvePreview!: (impact: typeof refreshed) => void;
    const preview = new Promise<typeof refreshed>((resolve) => resolvePreview = resolve);
    let actionable = true;
    let accepted: typeof refreshed | undefined;
    let failed = false;

    const refresh = refreshWideningConfirmation(
      () => preview,
      {
        markStale: () => actionable = false,
        accept: (impact) => {
          accepted = impact;
          actionable = true;
          return true;
        },
        markFailed: () => failed = true,
      },
    );

    expect(actionable).toBe(false);
    expect(accepted).toBeUndefined();
    resolvePreview(refreshed);
    await expect(refresh).resolves.toBe(true);
    expect(actionable).toBe(true);
    expect(accepted).toEqual(refreshed);
    expect(failed).toBe(false);
  });

  it("removes the group-save confirmation when re-preview finds no remaining impact", async () => {
    const noImpact: AccessGroupPolicyImpact = {
      modelIdsBecomingPublic: [],
      tokenIdsLosingGroupAccess: [],
      tokenIdsRevertingToOwnerInheritance: [],
    };
    let confirmation: typeof noImpact | undefined = {
      ...noImpact,
      modelIdsBecomingPublic: ["stale-model"],
    };

    const refreshed = await refreshWideningConfirmation(
      () => Promise.resolve(noImpact),
      {
        markStale: () => confirmation = undefined,
        accept: (impact) => {
          confirmation = actionableWideningImpact(impact);
          return true;
        },
        markFailed: () => {
          throw new Error("The successful re-preview must not be treated as a failure");
        },
      },
    );

    expect(refreshed).toBe(true);
    expect(confirmation).toBeUndefined();
  });

  it("keeps stale delete acknowledgement disabled when the impact refetch fails", async () => {
    let actionable = true;
    let failed = false;

    const refreshed = await refreshWideningConfirmation(
      () => Promise.resolve({ isSuccess: false }),
      {
        markStale: () => actionable = false,
        accept: (result) => {
          if (!result.isSuccess) return false;
          actionable = true;
          return true;
        },
        markFailed: () => failed = true,
      },
    );

    expect(refreshed).toBe(false);
    expect(actionable).toBe(false);
    expect(failed).toBe(true);
  });
});
