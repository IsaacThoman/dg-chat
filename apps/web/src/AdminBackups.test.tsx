import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AdminBackups,
  applyValidatedBackupRestore,
  canApplyBackupRestore,
  createBackupUploadAttempt,
  isRecentAuthenticationRequired,
  mergeBackupExport,
  monitorBackupRestore,
  PRIVILEGED_BACKUP_CONFIRMATION,
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

  it("keeps privileged recovery visibly separate and fail-closed", () => {
    const disabled = renderToStaticMarkup(
      <AdminBackups {...base} privilegedSecretBackupsEnabled={false} />,
    );
    expect(disabled).toContain("Privileged secret backups are disabled");
    expect(disabled).toContain("independent recovery keyring");
    expect(disabled).not.toContain("Create paired export");

    const enabled = renderToStaticMarkup(
      <AdminBackups
        {...base}
        privilegedSecretBackupsEnabled
        onCreatePrivileged={async () => {}}
      />,
    );
    expect(enabled).toContain("Provider-secret recovery");
    expect(enabled).toContain("recovery key is not stored in either download");
    expect(enabled).toContain(PRIVILEGED_BACKUP_CONFIRMATION);
    expect(enabled).toContain("Anyone holding all three can recover provider credentials");
    expect(enabled).toContain('disabled=""');
  });

  it("shows both independently downloadable artifacts for a completed paired export", () => {
    const html = renderToStaticMarkup(
      <AdminBackups
        {...base}
        privilegedSecretBackupsEnabled
        onCreatePrivileged={async () => {}}
        onDownloadSecrets={async () => {}}
        exports={[{
          id: "paired",
          status: "completed",
          formatVersion: 1,
          includesDiagnostics: false,
          secretsRedacted: true,
          bytes: 4096,
          fingerprint: "a".repeat(64),
          createdAt: "2026-07-12T00:00:00Z",
          completedAt: "2026-07-12T00:01:00Z",
          error: null,
          providerSecrets: {
            status: "completed",
            encrypted: true,
            providerCount: 3,
            bytes: 512,
            fingerprint: "b".repeat(64),
            recoveryKeyId: "recovery-2026",
          },
        }]}
      />,
    );
    expect(html).toContain("Encrypted sidecar");
    expect(html).toContain("3 providers");
    expect(html).toContain("recovery-2026");
    expect(html).toContain(".dgbackup");
    expect(html).toContain(".dgsecrets");
  });

  it("preserves privileged capability during optimistic ordinary-export updates", () => {
    const item = {
      id: "ordinary",
      status: "queued" as const,
      formatVersion: 1,
      includesDiagnostics: false,
      secretsRedacted: true as const,
      bytes: null,
      fingerprint: null,
      createdAt: "2026-07-12T00:00:00Z",
      completedAt: null,
      error: null,
    };
    const updated = mergeBackupExport({
      items: [],
      restoreEnabled: true,
      privilegedSecretBackupsEnabled: true,
    }, item);
    expect(updated.items).toEqual([item]);
    expect(updated.restoreEnabled).toBe(true);
    expect(updated.privilegedSecretBackupsEnabled).toBe(true);
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

  it("keeps polling after an ambiguous apply transport failure and confirms completion", async () => {
    const controller = new AbortController();
    const updates: string[] = [];
    const statuses = [
      { status: "running" as const, stage: "restore_staging", completedAt: null, error: null },
      {
        status: "completed" as const,
        stage: "completed",
        completedAt: "2026-07-12T00:01:00Z",
        error: null,
      },
    ];
    await expect(monitorBackupRestore({
      restoreId: "restore-1",
      fingerprint: "a".repeat(64),
      capability: { token: "payload.signature", expiresAt: "2099-01-01T00:00:00Z" },
      signal: controller.signal,
      apply: () => Promise.reject(new TypeError("connection reset")),
      status: () =>
        Promise.resolve({ restoreId: "restore-1", ...(statuses.shift() ?? statuses[0]) }),
      onStatus: (status) => updates.push(typeof status === "string" ? status : status.status),
      pollIntervalMs: 0,
    })).resolves.toBe("completed");
    expect(updates).toEqual(["transport-ambiguous", "running", "completed"]);
  });

  it("reports a durable failed status after an ambiguous apply transport failure", async () => {
    await expect(monitorBackupRestore({
      restoreId: "restore-1",
      fingerprint: "a".repeat(64),
      capability: { token: "payload.signature", expiresAt: "2099-01-01T00:00:00Z" },
      signal: new AbortController().signal,
      apply: () => Promise.reject(new TypeError("offline")),
      status: () =>
        Promise.resolve({
          restoreId: "restore-1",
          status: "failed",
          stage: "failed",
          completedAt: "2026-07-12T00:01:00Z",
          error: "internal_error",
        }),
      onStatus: () => {},
      pollIntervalMs: 0,
    })).resolves.toBe("failed");
  });

  it("disambiguates a conflict response through durable status after a lost commit response", async () => {
    const updates: string[] = [];
    await expect(monitorBackupRestore({
      restoreId: "restore-1",
      fingerprint: "a".repeat(64),
      capability: { token: "payload.signature", expiresAt: "2099-01-01T00:00:00Z" },
      signal: new AbortController().signal,
      apply: () => Promise.reject(new ApiError(409, "conflict", "Restore could not complete")),
      status: () =>
        Promise.resolve({
          restoreId: "restore-1",
          status: "completed",
          stage: "completed",
          completedAt: "2026-07-12T00:01:00Z",
          error: null,
        }),
      onStatus: (status) => updates.push(typeof status === "string" ? status : status.status),
      pollIntervalMs: 0,
    })).resolves.toBe("completed");
    expect(updates).toEqual(["transport-ambiguous", "completed"]);
  });

  it("stops retrying when the signed status capability expires", async () => {
    let clock = 1_000;
    await expect(monitorBackupRestore({
      restoreId: "restore-1",
      fingerprint: "a".repeat(64),
      capability: { token: "payload.signature", expiresAt: new Date(1_001).toISOString() },
      signal: new AbortController().signal,
      apply: () => Promise.reject(new TypeError("offline")),
      status: () => {
        clock = 1_002;
        return Promise.resolve({
          restoreId: "restore-1",
          status: "running",
          stage: "restore_staging",
          completedAt: null,
          error: null,
        });
      },
      onStatus: () => {},
      pollIntervalMs: 0,
      now: () => clock,
    })).rejects.toThrow("authorization expired");
  });

  it("aborts independent apply and status work when its owner unmounts", async () => {
    const owner = new AbortController();
    let applyAborted = false;
    let statusAborted = false;
    let statusStarted!: () => void;
    const started = new Promise<void>((resolve) => statusStarted = resolve);
    const work = monitorBackupRestore({
      restoreId: "restore-1",
      fingerprint: "a".repeat(64),
      capability: { token: "payload.signature", expiresAt: "2099-01-01T00:00:00Z" },
      signal: owner.signal,
      apply: (signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => {
            applyAborted = true;
            reject(signal.reason);
          }, { once: true })
        ),
      status: (signal) => {
        statusStarted();
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => {
            statusAborted = true;
            reject(signal.reason);
          }, { once: true })
        );
      },
      onStatus: () => {},
      pollIntervalMs: 0,
    });
    await started;
    owner.abort();
    await expect(work).rejects.toMatchObject({ name: "AbortError" });
    expect(applyAborted).toBe(true);
    expect(statusAborted).toBe(true);
  });
});
