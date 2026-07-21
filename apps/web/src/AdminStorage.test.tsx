import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AdminStorage,
  boundedStorageFilters,
  isAttachmentVersionConflict,
  reconcileReinspectedAttachment,
  removeConflictedAttachment,
} from "./AdminStorage.tsx";
import { ApiError } from "./api.ts";

const filters = { ownerId: "", state: "" as const, deletion: "present" as const };
const base = {
  filters,
  hasPrevious: false,
  onApply: () => {},
  onRetrySummary: () => {},
  onRetryInventory: () => {},
  onNext: () => {},
  onPrevious: () => {},
  onReinspect: () => Promise.resolve(),
  onResetReinspection: () => {},
};
const attachment = {
  id: "00000000-0000-4000-8000-000000000001",
  ownerId: "00000000-0000-4000-8000-000000000002",
  filename: "policy-review.pdf",
  mimeType: "application/pdf",
  sizeBytes: 42_000,
  state: "quarantined" as const,
  inspectionError: "Archive policy rejected content",
  inspectionEpoch: 2,
  version: 3,
  reinspectionEligible: true,
  reinspectionBlockedReason: null,
  createdAt: "2026-07-17T10:00:00.000Z",
  updatedAt: "2026-07-17T11:00:00.000Z",
  deletedAt: null,
};

describe("AdminStorage", () => {
  it("distinguishes stale versions from permanent 409 policy conflicts", () => {
    expect(isAttachmentVersionConflict(new ApiError(409, "version_conflict", "changed"))).toBe(
      true,
    );
    expect(
      isAttachmentVersionConflict(
        new ApiError(409, "attachment_state_conflict", "policy quarantine"),
      ),
    ).toBe(false);
    expect(isAttachmentVersionConflict(new ApiError(409, "attachment_deleted", "deleted"))).toBe(
      false,
    );
  });

  it("removes a known-stale conflicted row until authoritative inventory reloads", () => {
    const page = { data: [attachment], nextCursor: "next" };
    expect(removeConflictedAttachment(page, attachment.id)).toEqual({
      data: [],
      nextCursor: "next",
    });
    expect(removeConflictedAttachment(page, "missing")).toBe(page);
    expect(removeConflictedAttachment(undefined, attachment.id)).toBeUndefined();
  });

  it("renders accessible summary, filters, safe inventory, and worker-only action language", () => {
    const markup = renderToStaticMarkup(
      <AdminStorage
        {...base}
        summary={{
          physicalBytes: 42_000,
          physicalObjects: 1,
          attachmentRecords: 1,
          activeRecords: 1,
          deletedRecords: 0,
          quarantinedRecords: 1,
          ownersWithStorage: 1,
          perUserBytesLimit: 5_000_000,
          perUserObjectsLimit: 100,
          installationBytesLimit: 10_000_000,
          installationObjectsLimit: 1_000,
          installationBytesRemaining: 9_958_000,
          installationObjectsRemaining: 999,
          installationBytesOverage: 0,
          installationObjectsOverage: 0,
          installationBytesPercent: 0.42,
          installationObjectsPercent: 0.1,
        }}
        page={{ data: [attachment], nextCursor: "next-page" }}
      />,
    );
    expect(markup).toContain('aria-label="Installation storage summary"');
    expect(markup).toContain('aria-label="Attachment filters"');
    expect(markup).toContain('aria-label="Attachment pages"');
    expect(markup).toContain("Soft deletion does not reclaim");
    expect(markup).toContain("Reinspect");
    expect(markup).not.toContain("Release");
    expect(markup).not.toContain("objectKey");
    expect(markup).not.toContain("users/private");
  });

  it("renders actual storage overage instead of clamping it to the limit", () => {
    const markup = renderToStaticMarkup(
      <AdminStorage
        {...base}
        summary={{
          physicalBytes: 15_000_000,
          physicalObjects: 1_500,
          attachmentRecords: 1_500,
          activeRecords: 1_500,
          deletedRecords: 0,
          quarantinedRecords: 0,
          ownersWithStorage: 2,
          installationBytesLimit: 10_000_000,
          installationObjectsLimit: 1_000,
          installationBytesRemaining: 0,
          installationObjectsRemaining: 0,
          installationBytesOverage: 5_000_000,
          installationObjectsOverage: 500,
          installationBytesPercent: 150,
          installationObjectsPercent: 150,
        }}
        page={{ data: [], nextCursor: null }}
      />,
    );
    expect(markup).toContain("150.0% used");
    expect(markup).toContain("5MB over limit");
    expect(markup).toContain("500 over limit");
  });

  it("uses readable over-limit copy when a configured zero limit has existing usage", () => {
    const markup = renderToStaticMarkup(
      <AdminStorage
        {...base}
        summary={{
          physicalBytes: 1,
          physicalObjects: 1,
          attachmentRecords: 1,
          activeRecords: 1,
          deletedRecords: 0,
          quarantinedRecords: 0,
          ownersWithStorage: 1,
          installationBytesLimit: 0,
          installationObjectsLimit: 0,
          installationBytesRemaining: 0,
          installationObjectsRemaining: 0,
          installationBytesOverage: 1,
          installationObjectsOverage: 1,
          installationBytesPercent: null,
          installationObjectsPercent: null,
        }}
        page={{ data: [], nextCursor: null }}
      />,
    );
    expect(markup).toContain("Over limit · 1B over limit");
    expect(markup).toContain("Over limit · 1 over limit");
    expect(markup).not.toContain("Over limit% used");
  });

  it("provides explicit blocking error and empty states with retry actions", () => {
    const error = renderToStaticMarkup(
      <AdminStorage
        {...base}
        summaryError="Summary unavailable"
        inventoryError="Inventory unavailable"
      />,
    );
    expect(error.match(/role="alert"/g)).toHaveLength(2);
    expect(error).toContain("Retry loading summary");
    expect(error).toContain("Retry loading attachments");
    const empty = renderToStaticMarkup(
      <AdminStorage
        {...base}
        summaryLoading
        inventoryLoading
        page={{ data: [], nextCursor: null }}
      />,
    );
    expect(empty).toContain("Loading storage summary");
    expect(empty).toContain("Loading attachment inventory");
    expect(empty).toContain("No attachments match");
  });

  it("keeps an inventory refresh action visible when a background refetch fails", () => {
    const markup = renderToStaticMarkup(
      <AdminStorage
        {...base}
        page={{ data: [], nextCursor: null }}
        inventoryError="The authoritative refresh failed."
      />,
    );
    expect(markup).toContain("Showing older results");
    expect(markup).toContain("Refresh attachment inventory");
  });

  it("bounds filter text and restores unknown enum values to safe defaults", () => {
    expect(
      boundedStorageFilters({
        ownerId: `  ${"a".repeat(50)}  `,
        state: "unknown" as never,
        deletion: "unknown" as never,
      }),
    ).toEqual({
      ownerId: "a".repeat(36),
      state: "",
      deletion: "present",
    });
  });

  it("removes reinspected attachments that no longer match the active state filter", () => {
    const page = { data: [attachment], nextCursor: null };
    const pending = {
      ...attachment,
      state: "pending" as const,
      inspectionError: null,
      inspectionEpoch: 3,
      version: 4,
    };
    expect(
      reconcileReinspectedAttachment(
        page,
        { state: "quarantined", deletion: "present", limit: 25 },
        pending,
      ),
    ).toEqual({ data: [], nextCursor: null });
  });

  it("keeps the authoritative reinspected attachment on unfiltered pages", () => {
    const page = { data: [attachment], nextCursor: null };
    const pending = {
      ...attachment,
      state: "pending" as const,
      inspectionError: null,
      inspectionEpoch: 3,
      version: 4,
    };
    expect(
      reconcileReinspectedAttachment(
        page,
        { deletion: "present", limit: 25 },
        pending,
      ),
    ).toEqual({ data: [pending], nextCursor: null });
  });

  it("does not offer reinspection when the server marks a policy quarantine ineligible", () => {
    const markup = renderToStaticMarkup(
      <AdminStorage
        {...base}
        page={{
          data: [{
            ...attachment,
            reinspectionEligible: false,
            reinspectionBlockedReason: "policy_quarantine",
          }],
          nextCursor: null,
        }}
      />,
    );
    expect(markup).not.toContain("Reinspect");
  });
});
