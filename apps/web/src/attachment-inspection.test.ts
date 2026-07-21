import { describe, expect, it } from "vitest";
import { friendlyAttachmentInspectionError } from "./attachment-inspection.ts";

describe("friendlyAttachmentInspectionError", () => {
  it("translates stable worker and upload-security reason codes", () => {
    expect(friendlyAttachmentInspectionError("worker_malware_detected")).toContain(
      "unsafe content",
    );
    expect(friendlyAttachmentInspectionError("worker_external_scanner_unavailable")).toContain(
      "temporarily unavailable",
    );
    expect(friendlyAttachmentInspectionError("security_scan_inconclusive")).toContain(
      "could not confirm",
    );
  });

  it("does not expose unknown machine codes and preserves intentional prose", () => {
    expect(friendlyAttachmentInspectionError("future_internal_reason_code")).not.toContain(
      "future_internal_reason_code",
    );
    expect(friendlyAttachmentInspectionError("Administrator review is required.")).toBe(
      "Administrator review is required.",
    );
    expect(friendlyAttachmentInspectionError(null)).toBeUndefined();
  });
});
