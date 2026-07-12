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

  it("requires the exact privileged confirmation and downloads the sidecar separately", async () => {
    const paired = {
      id: "paired/1",
      status: "queued",
      providerSecrets: { status: "queued", encrypted: true },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(paired, { status: 202 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.createAdminPrivilegedBackupExport(
      "privileged-attempt",
      "EXPORT PROVIDER SECRETS",
    );
    const blob = await api.downloadAdminProviderSecrets("paired/1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/admin/backups/privileged-exports",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({ "Idempotency-Key": "privileged-attempt" }),
        body: JSON.stringify({
          includeDiagnostics: false,
          confirmation: "EXPORT PROVIDER SECRETS",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/admin/backups/paired%2F1/provider-secrets/content",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(blob?.size).toBe(3);
    expect(api.adminProviderSecretsContentUrl("paired/1")).toBe(
      "/api/admin/backups/paired%2F1/provider-secrets/content",
    );
  });

  it("preserves the dedicated recent-auth error while downloading provider secrets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({
        error: { code: "recent_authentication_required", message: "Sign in again" },
      }, { status: 403 })),
    );
    await expect(api.downloadAdminProviderSecrets("paired")).rejects.toMatchObject({
      status: 403,
      code: "recent_authentication_required",
      message: "Sign in again",
    });
  });

  it("streams provider secrets directly into a supplied file destination", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
    );
    const chunks: number[] = [];
    const destination = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(...chunk);
      },
    });
    await expect(api.downloadAdminProviderSecrets("paired", destination)).resolves.toBeUndefined();
    expect(chunks).toEqual([1, 2, 3]);
  });

  it("aborts a picker-created destination when authorization fails before streaming", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({
        error: { code: "recent_authentication_required", message: "Sign in again" },
      }, { status: 403 })),
    );
    const abort = vi.fn();
    const destination = new WritableStream<Uint8Array>({ abort });
    await expect(api.downloadAdminProviderSecrets("paired", destination)).rejects.toMatchObject({
      code: "recent_authentication_required",
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(abort.mock.calls[0][0]).toMatchObject({ code: "recent_authentication_required" });
  });

  it("rejects oversized compatibility downloads before buffering response bytes", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "Content-Length": String(32 * 1024 * 1024 + 1) },
        }),
      ),
    );
    await expect(api.downloadAdminProviderSecrets("oversized")).rejects.toMatchObject({
      status: 413,
      code: "download_too_large_for_browser",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("uploads a sidecar with stable identity and binds preview/apply to both fingerprints", async () => {
    let xhr: RestoreSidecarXhr | undefined;
    class RestoreSidecarXhr {
      status = 201;
      responseText = JSON.stringify({ id: "sidecar", restoreId: "restore" });
      withCredentials = false;
      upload: { onprogress?: (event: ProgressEvent) => void } = {};
      onerror?: () => void;
      onabort?: () => void;
      onload?: () => void;
      headers = new Map<string, string>();
      url = "";
      constructor() {
        xhr = this;
      }
      open(_method: string, url: string) {
        this.url = url;
      }
      setRequestHeader(name: string, value: string) {
        this.headers.set(name, value);
      }
      send() {
        this.onload?.();
      }
      abort() {
        this.onabort?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", RestoreSidecarXhr);
    await api.uploadAdminProviderSecretRestore(
      "restore/one",
      new File(["encrypted"], "paired.dgsecrets"),
      "stable-sidecar-upload",
    );
    expect(xhr?.url).toBe(
      "/api/admin/backups/restores/restore%2Fone/provider-secrets/uploads",
    );
    expect(xhr?.withCredentials).toBe(true);
    expect(xhr?.headers.get("Idempotency-Key")).toBe("stable-sidecar-upload");

    const preview = {
      id: "sidecar/one",
      restoreId: "restore/one",
      status: "validated" as const,
      version: 2,
      baseFingerprint: "a".repeat(64),
      sidecarFingerprint: "b".repeat(64),
      recoveryKeyId: "recovery-2026",
      recordCount: 1,
      providers: [],
      warnings: [],
      blockingErrors: [],
      providersRemainDisabled: true as const,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(preview))
      .mockResolvedValueOnce(Response.json({ status: "applied" }));
    vi.stubGlobal("fetch", fetchMock);
    await api.previewAdminProviderSecretRestore(preview.restoreId, preview.id);
    await api.applyAdminProviderSecretRestore(preview, "RESTORE PROVIDER SECRETS");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/admin/backups/restores/restore%2Fone/provider-secrets/sidecar%2Fone/dry-run",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/admin/backups/restores/restore%2Fone/provider-secrets/sidecar%2Fone/apply",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          confirmation: "RESTORE PROVIDER SECRETS",
          expectedVersion: 2,
          baseFingerprint: "a".repeat(64),
          sidecarFingerprint: "b".repeat(64),
        }),
      }),
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
