import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AdminStorage,
  boundedStorageFilters,
  reconcileReinspectedAttachment,
} from "./AdminStorage.tsx";

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
