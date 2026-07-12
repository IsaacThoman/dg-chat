import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.ts";

afterEach(() => vi.unstubAllGlobals());

describe("backup administration API", () => {
  it("uses same-origin routes and always disables diagnostic payload export", async () => {
    const exportItem = {
      id: "export/1",
      status: "queued",
      formatVersion: 1,
      includesDiagnostics: false,
      secretsRedacted: true,
      bytes: null,
      fingerprint: null,
      createdAt: "2026-07-12T00:00:00Z",
      completedAt: null,
      error: null,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ items: [], restoreEnabled: false }))
      .mockResolvedValueOnce(Response.json(exportItem));
    vi.stubGlobal("fetch", fetchMock);

    await api.adminBackups();
    await api.createAdminBackupExport("export-attempt-123");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/admin/backups",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/admin/backups/exports",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({ "Idempotency-Key": "export-attempt-123" }),
        body: JSON.stringify({ includeDiagnostics: false }),
      }),
    );
    expect(api.adminBackupContentUrl("archive/one")).toBe(
      "/api/admin/backups/archive%2Fone/content",
    );
  });

  it("wires cancellation to the active XHR while retaining its idempotency header", async () => {
    let xhr: FakeXhr | undefined;
    class FakeXhr {
      status = 0;
      responseText = "";
      withCredentials = false;
      upload: { onprogress?: (event: ProgressEvent) => void } = {};
      onerror?: () => void;
      onabort?: () => void;
      onload?: () => void;
      headers = new Map<string, string>();
      aborted = false;
      constructor() {
        xhr = this;
      }
      open() {}
      setRequestHeader(name: string, value: string) {
        this.headers.set(name, value);
      }
      send() {}
      abort() {
        this.aborted = true;
        this.onabort?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const controller = new AbortController();
    const pending = api.uploadAdminBackupRestore(
      new File(["archive"], "backup.dgbackup"),
      "stable-upload-attempt",
      undefined,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(xhr?.aborted).toBe(true);
    expect(xhr?.headers.get("Idempotency-Key")).toBe("stable-upload-attempt");
  });

  it("binds dry-run and apply to encoded restore IDs and exact fingerprints", async () => {
    const preview = {
      restoreId: "restore/1",
      fingerprint: "sha256:exact",
      formatVersion: 1,
      createdAt: "2026-07-12T00:00:00Z",
      counts: [],
      warnings: [],
      blockingErrors: [],
      secretsRedacted: true,
      attachmentsMissing: 0,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(preview))
      .mockResolvedValueOnce(Response.json({
        restoreId: preview.restoreId,
        status: "completed",
        completedAt: "2026-07-12T00:01:00Z",
        counts: [],
      }));
    vi.stubGlobal("fetch", fetchMock);

    await api.previewAdminBackupRestore("restore/1");
    await api.applyAdminBackupRestore("restore/1", preview.fingerprint);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/admin/backups/restores/restore%2F1/dry-run",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/admin/backups/restores/restore%2F1/apply",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ fingerprint: "sha256:exact" }),
      }),
    );
  });
});
