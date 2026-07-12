import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AdminBackups,
  applyValidatedBackupRestore,
  canApplyBackupRestore,
  createBackupUploadAttempt,
  isRecentAuthenticationRequired,
} from "./AdminBackups.tsx";
import { ApiError } from "./api.ts";

const base = { exports: [], restoreEnabled: true, onRetry: () => {}, onCreate: async () => {} };

describe("AdminBackups", () => {
  it("warns that standard archives are sensitive and renders useful empty and upload states", () => {
    const html = renderToStaticMarkup(<AdminBackups {...base} />);
    expect(html).toContain(
      "Store every downloaded archive in encrypted, access-controlled storage",
    );
    expect(html).toContain("credential hashes");
    expect(html).toContain("Request and response diagnostics are excluded");
    expect(html).toContain("provider credentials are redacted");
    expect(html).toContain("No exports yet");
    expect(html).toContain("Choose a backup or drop it here");
    expect(html).toContain("Uploading and dry-running never alters application data");
  });

  it("distinguishes loading, failed, active, and downloadable exports", () => {
    expect(renderToStaticMarkup(<AdminBackups {...base} loading />)).toContain(
      "Loading backup history",
    );
    expect(renderToStaticMarkup(<AdminBackups {...base} loadError="Offline" />)).toContain(
      'role="alert"',
    );
    const html = renderToStaticMarkup(
      <AdminBackups
        {...base}
        exports={[
          {
            id: "done",
            status: "completed",
            formatVersion: 1,
            includesDiagnostics: false,
            secretsRedacted: true,
            bytes: 1200,
            fingerprint: "sha256:abc",
            createdAt: "2026-07-12T00:00:00Z",
            completedAt: "2026-07-12T00:01:00Z",
            error: null,
          },
          {
            id: "active",
            status: "running",
            formatVersion: 1,
            includesDiagnostics: false,
            secretsRedacted: true,
            bytes: null,
            fingerprint: null,
            createdAt: "2026-07-12T00:02:00Z",
            completedAt: null,
            error: null,
          },
        ]}
      />,
    );
    expect(html).toContain("Download");
    expect(html).toContain('aria-label="Export progress"');
    expect(html).toContain("Format v1");
  });

  it("keeps the destructive action absent before a successful dry run", () => {
    const html = renderToStaticMarkup(<AdminBackups {...base} createError="Export unavailable" />);
    expect(html).toContain("Export unavailable");
    expect(html).not.toContain("Apply transactional restore");
  });

  it("explains operator policy and disables restore intake without blocking exports", () => {
    const html = renderToStaticMarkup(<AdminBackups {...base} restoreEnabled={false} />);
    expect(html).toContain("ALLOW_IN_APP_RESTORE=true");
    expect(html).toContain("Export and download remain safe to");
    expect(html).toContain('class="primary"');
    expect(html).toContain('class="backup-dropzone " disabled=""');
  });

  it("requires an exact fingerprint and a blocker-free fresh preview", () => {
    const preview = {
      restoreId: "restore-1",
      fingerprint: "sha256:CaseSensitive",
      formatVersion: 1,
      createdAt: "2026-07-12T00:00:00Z",
      counts: [],
      warnings: [],
      blockingErrors: [],
      secretsRedacted: true,
      attachmentsMissing: 0,
    };
    expect(canApplyBackupRestore(undefined, preview.fingerprint)).toBe(false);
    expect(canApplyBackupRestore(preview, "sha256:casesensitive")).toBe(false);
    expect(canApplyBackupRestore(preview, preview.fingerprint)).toBe(true);
    expect(
      canApplyBackupRestore({ ...preview, blockingErrors: ["Invalid owner"] }, preview.fingerprint),
    )
      .toBe(false);
    expect(canApplyBackupRestore(preview, preview.fingerprint, true)).toBe(false);
    expect(canApplyBackupRestore(preview, preview.fingerprint, false, false)).toBe(false);
  });

  it("retains one idempotency key only while retrying the same selected file", () => {
    const firstFile = new File(["one"], "first.dgbackup");
    const secondFile = new File(["two"], "second.dgbackup");
    const first = createBackupUploadAttempt(firstFile, "attempt-one");
    const retry = first;
    const replacement = createBackupUploadAttempt(secondFile, "attempt-two");
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(retry.file).toBe(firstFile);
    expect(replacement.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(replacement.file).toBe(secondFile);
  });

  it("reauthenticates only after a permitted restore succeeds", async () => {
    const preview = {
      restoreId: "restore-1",
      fingerprint: "a".repeat(64),
      formatVersion: 1,
      createdAt: "2026-07-12T00:00:00Z",
      counts: [],
      warnings: [],
      blockingErrors: [],
      secretsRedacted: true,
      attachmentsMissing: 0,
    };
    const events: string[] = [];
    const apply = vi.fn(() => {
      events.push("applied");
      return Promise.resolve();
    });
    const reauthenticate = vi.fn(() => events.push("reauthenticate"));
    await expect(
      applyValidatedBackupRestore(preview, "wrong", true, apply, reauthenticate),
    ).resolves.toBe(false);
    expect(apply).not.toHaveBeenCalled();
    await expect(
      applyValidatedBackupRestore(preview, preview.fingerprint, true, apply, reauthenticate),
    ).resolves.toBe(true);
    expect(events).toEqual(["applied", "reauthenticate"]);
  });

  it("recognizes only the dedicated recent-authentication response", () => {
    expect(
      isRecentAuthenticationRequired(
        new ApiError(403, "recent_authentication_required", "Sign in again"),
      ),
    ).toBe(true);
    expect(isRecentAuthenticationRequired(new ApiError(403, "forbidden", "No"))).toBe(false);
    expect(isRecentAuthenticationRequired(new Error("Sign in again"))).toBe(false);
  });
});
