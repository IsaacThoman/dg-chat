import { type DragEvent, type FormEvent, useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileArchive,
  KeyRound,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { api, ApiError } from "./api.ts";
import { ProviderSecretRestore } from "./ProviderSecretRestore.tsx";
import type {
  BackupExport,
  BackupExportPage,
  BackupRestorePreview,
  BackupRestoreStatus,
  BackupRestoreStatusCapability,
  BackupRestoreUpload,
} from "./types.ts";

const message = (error: unknown) => error instanceof Error ? error.message : "The request failed.";
const size = (bytes: number | null) =>
  bytes === null
    ? "—"
    : new Intl.NumberFormat(undefined, { style: "unit", unit: "byte", notation: "compact" })
      .format(bytes);
const terminal = (item: BackupExport) => item.status === "completed" || item.status === "failed";
export const PRIVILEGED_BACKUP_CONFIRMATION = "EXPORT PROVIDER SECRETS";
export const mergeBackupExport = (
  current: BackupExportPage | undefined,
  item: BackupExport,
): BackupExportPage => ({
  items: [item, ...(current?.items ?? []).filter((existing) => existing.id !== item.id)],
  restoreEnabled: current?.restoreEnabled ?? false,
  privilegedSecretBackupsEnabled: current?.privilegedSecretBackupsEnabled ?? false,
  providerSecretRestoreEnabled: current?.providerSecretRestoreEnabled ?? false,
});
export const isRecentAuthenticationRequired = (error: unknown) =>
  error instanceof ApiError && error.status === 403 &&
  error.code === "recent_authentication_required";
export const canApplyBackupRestore = (
  preview: BackupRestorePreview | undefined,
  confirmation: string,
  completed = false,
  restoreEnabled = true,
) =>
  Boolean(
    restoreEnabled && preview && !completed && preview.blockingErrors.length === 0 &&
      confirmation === preview.fingerprint,
  );

export interface BackupUploadAttempt {
  file: File;
  idempotencyKey: string;
}
export const createBackupUploadAttempt = (
  file: File,
  idempotencyKey: string = crypto.randomUUID(),
): BackupUploadAttempt => ({ file, idempotencyKey });

export async function applyValidatedBackupRestore(
  preview: BackupRestorePreview | undefined,
  confirmation: string,
  restoreEnabled: boolean,
  applyRestore: (id: string, fingerprint: string) => Promise<unknown>,
  onReauthenticate: () => void,
) {
  if (!canApplyBackupRestore(preview, confirmation, false, restoreEnabled) || !preview) {
    return false;
  }
  await applyRestore(preview.restoreId, preview.fingerprint);
  onReauthenticate();
  return true;
}

export interface MonitorBackupRestoreOptions {
  restoreId: string;
  fingerprint: string;
  capability: BackupRestoreStatusCapability;
  signal: AbortSignal;
  apply(signal: AbortSignal): Promise<unknown>;
  status(signal: AbortSignal): Promise<BackupRestoreStatus>;
  onStatus(status: BackupRestoreStatus | "transport-ambiguous"): void;
  pollIntervalMs?: number;
  now?: () => number;
}

const abortError = () => new DOMException("Restore monitoring was cancelled", "AbortError");

/**
 * Dispatches a restore and independently monitors its signed, session-free status capability.
 * Once dispatch starts, a transport error is ambiguous: only a terminal durable status may tell
 * the operator whether the transaction committed. Structured API responses remain authoritative
 * pre-commit failures and are returned immediately.
 */
export async function monitorBackupRestore(
  options: MonitorBackupRestoreOptions,
): Promise<"completed" | "failed"> {
  const now = options.now ?? Date.now;
  const expiresAt = Date.parse(options.capability.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
    throw new Error("Restore status authorization expired. Dry-run the backup and try again.");
  }
  const applyController = new AbortController();
  const pollController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let resolveTerminal!: (outcome: "completed" | "failed") => void;
  let rejectTerminal!: (error: unknown) => void;
  const terminal = new Promise<"completed" | "failed">((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });
  const finish = (outcome: "completed" | "failed") => {
    if (settled) return;
    settled = true;
    resolveTerminal(outcome);
  };
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    rejectTerminal(error);
  };
  const cancel = () => {
    applyController.abort(abortError());
    pollController.abort(abortError());
    fail(abortError());
  };
  options.signal.addEventListener("abort", cancel, { once: true });
  if (options.signal.aborted) cancel();
  const expiryTimer = setTimeout(() => {
    fail(
      new Error(
        "Restore status authorization expired before a terminal result was confirmed. Check server logs before retrying.",
      ),
    );
    applyController.abort(abortError());
    pollController.abort(abortError());
  }, Math.max(0, Math.min(2_147_483_647, expiresAt - now())));

  const wait = (milliseconds: number) =>
    new Promise<void>((resolve, reject) => {
      if (pollController.signal.aborted) return reject(abortError());
      const onAbort = () => {
        if (timer !== undefined) clearTimeout(timer);
        reject(abortError());
      };
      timer = setTimeout(() => {
        pollController.signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      pollController.signal.addEventListener("abort", onAbort, { once: true });
    });

  void (async () => {
    try {
      await options.apply(applyController.signal);
      finish("completed");
    } catch (error) {
      if (applyController.signal.aborted || settled) return;
      // These responses are emitted before restore execution begins. Conflict and server errors
      // can instead represent an unknown commit/finalization outcome and must be disambiguated.
      if (
        error instanceof ApiError &&
        [400, 401, 403, 404, 422, 429].includes(error.status)
      ) {
        fail(error);
        return;
      }
      // Fetch/network failure after dispatch cannot establish whether PostgreSQL committed.
      options.onStatus("transport-ambiguous");
    }
  })();

  void (async () => {
    const interval = Math.max(0, options.pollIntervalMs ?? 2_000);
    try {
      while (!settled && !pollController.signal.aborted) {
        const remaining = expiresAt - now();
        if (remaining <= 0) {
          fail(
            new Error(
              "Restore status authorization expired before a terminal result was confirmed. Check server logs before retrying.",
            ),
          );
          return;
        }
        await wait(Math.min(interval, remaining));
        if (settled || pollController.signal.aborted) return;
        try {
          const status = await options.status(pollController.signal);
          if (settled || pollController.signal.aborted) return;
          options.onStatus(status);
          if (status.status === "completed" || status.status === "failed") {
            finish(status.status);
          }
        } catch (error) {
          if (pollController.signal.aborted || settled) return;
          if (error instanceof ApiError && error.status === 404) {
            fail(
              new Error(
                "Restore status authorization expired before a terminal result was confirmed. Check server logs before retrying.",
              ),
            );
          }
          // Transient status transport failures retry until the signed capability expires.
        }
      }
    } catch (error) {
      if (!settled) fail(error);
    }
  })();

  try {
    return await terminal;
  } finally {
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    clearTimeout(expiryTimer);
    applyController.abort(abortError());
    pollController.abort(abortError());
    options.signal.removeEventListener("abort", cancel);
  }
}

export function AdminBackupsView() {
  const client = useQueryClient();
  const exportKey = useRef(crypto.randomUUID());
  const [recentRestoreId, setRecentRestoreId] = useState(() =>
    globalThis.sessionStorage?.getItem("dg.provider-secret-restore-id") ?? undefined
  );
  const backups = useQuery({
    queryKey: ["admin-backups"],
    queryFn: api.adminBackups,
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => !terminal(item)) ? 2_000 : false,
  });
  const create = useMutation({
    mutationFn: () => api.createAdminBackupExport(exportKey.current),
    onSuccess: (item) => {
      exportKey.current = crypto.randomUUID();
      client.setQueryData(
        ["admin-backups"],
        (current: typeof backups.data) => mergeBackupExport(current, item),
      );
    },
  });
  const privilegedKey = useRef(crypto.randomUUID());
  const privilegedCreate = useMutation({
    mutationFn: (confirmation: string) =>
      api.createAdminPrivilegedBackupExport(privilegedKey.current, confirmation),
    onSuccess: (item) => {
      privilegedKey.current = crypto.randomUUID();
      client.setQueryData(
        ["admin-backups"],
        (current: typeof backups.data) => mergeBackupExport(current, item),
      );
    },
  });
  const downloadSecrets = async (item: BackupExport) => {
    const filename = `dg-chat-provider-secrets-${item.id}.dgsecrets`;
    const picker = (globalThis as unknown as {
      showSaveFilePicker?: (options: {
        suggestedName: string;
        types: Array<{ description: string; accept: Record<string, string[]> }>;
      }) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>;
    }).showSaveFilePicker;
    if (picker) {
      // Open the picker before any network await so the browser still recognizes the click's user
      // activation. The response then pipes directly to disk instead of entering JS heap memory.
      const handle = await picker({
        suggestedName: filename,
        types: [{
          description: "DG Chat encrypted provider secrets",
          accept: { "application/vnd.dg-chat.provider-secrets": [".dgsecrets"] },
        }],
      });
      const writable = await handle.createWritable();
      await api.downloadAdminProviderSecrets(item.id, writable);
      return;
    }
    const blob = await api.downloadAdminProviderSecrets(item.id);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.rel = "noopener";
      anchor.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  return (
    <AdminBackups
      exports={backups.data?.items ?? []}
      restoreEnabled={backups.data?.restoreEnabled}
      privilegedSecretBackupsEnabled={backups.data?.privilegedSecretBackupsEnabled}
      providerSecretRestoreEnabled={backups.data?.providerSecretRestoreEnabled}
      recentRestoreId={recentRestoreId}
      loading={backups.isLoading}
      stale={backups.isError && backups.data !== undefined}
      loadError={backups.isError ? message(backups.error) : undefined}
      creating={create.isPending}
      createError={create.isError ? message(create.error) : undefined}
      creatingPrivileged={privilegedCreate.isPending}
      privilegedCreateError={privilegedCreate.isError ? privilegedCreate.error : undefined}
      onRetry={() => void backups.refetch()}
      onCreate={() => create.mutateAsync().then(() => undefined)}
      onCreatePrivileged={(confirmation) =>
        privilegedCreate.mutateAsync(confirmation).then(() => undefined)}
      onDownloadSecrets={downloadSecrets}
      onBaseRestoreCompleted={(restoreId) => {
        globalThis.sessionStorage?.setItem("dg.provider-secret-restore-id", restoreId);
        setRecentRestoreId(restoreId);
      }}
      onProviderSecretsApplied={() => {
        globalThis.sessionStorage?.removeItem("dg.provider-secret-restore-id");
        setRecentRestoreId(undefined);
      }}
      onReauthenticate={() => globalThis.location.assign("/login")}
    />
  );
}

export interface AdminBackupsProps {
  exports: BackupExport[];
  restoreEnabled?: boolean;
  privilegedSecretBackupsEnabled?: boolean;
  providerSecretRestoreEnabled?: boolean;
  recentRestoreId?: string;
  loading?: boolean;
  stale?: boolean;
  loadError?: string;
  creating?: boolean;
  createError?: string;
  creatingPrivileged?: boolean;
  privilegedCreateError?: unknown;
  onRetry(): void;
  onCreate(): Promise<void>;
  onCreatePrivileged?(confirmation: string): Promise<void>;
  onDownloadSecrets?(item: BackupExport): Promise<void>;
  onBaseRestoreCompleted?(restoreId: string): void;
  onProviderSecretsApplied?(): void;
  onReauthenticate?(): void;
}

export function AdminBackups(props: AdminBackupsProps) {
  const titleId = useId();
  const picker = useRef<HTMLInputElement>(null);
  const dropzone = useRef<HTMLButtonElement>(null);
  const restoreHeading = useRef<HTMLHeadingElement>(null);
  const uploadAttempt = useRef<BackupUploadAttempt | undefined>(undefined);
  const uploadController = useRef<AbortController | undefined>(undefined);
  const restoreController = useRef<AbortController | undefined>(undefined);
  const operationEpoch = useRef(0);
  const mounted = useRef(true);
  const [dragging, setDragging] = useState(false);
  const [upload, setUpload] = useState<BackupRestoreUpload>();
  const [uploadProgress, setUploadProgress] = useState<number>();
  const [uploadError, setUploadError] = useState<string>();
  const [uploadCancelled, setUploadCancelled] = useState(false);
  const [preview, setPreview] = useState<BackupRestorePreview>();
  const [previewError, setPreviewError] = useState<string>();
  const [previewing, setPreviewing] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string>();
  const [reauthRequired, setReauthRequired] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [restoreStage, setRestoreStage] = useState<string>();
  const [announcement, setAnnouncement] = useState("");
  const [privilegedConfirmation, setPrivilegedConfirmation] = useState("");
  const [privilegedError, setPrivilegedError] = useState<string>();
  const [secretDownloadId, setSecretDownloadId] = useState<string>();

  const createPrivileged = async (event: FormEvent) => {
    event.preventDefault();
    if (
      privilegedConfirmation !== PRIVILEGED_BACKUP_CONFIRMATION ||
      !props.onCreatePrivileged || props.creatingPrivileged
    ) return;
    setPrivilegedError(undefined);
    try {
      await props.onCreatePrivileged(privilegedConfirmation);
      setPrivilegedConfirmation("");
      setAnnouncement(
        "Encrypted provider-secret export started. Download both files when validation completes.",
      );
    } catch (error) {
      setPrivilegedConfirmation("");
      if (isRecentAuthenticationRequired(error)) {
        setPrivilegedError("Your sign-in is no longer recent enough. Redirecting to sign in.");
        globalThis.setTimeout(() => props.onReauthenticate?.(), 900);
      } else setPrivilegedError(message(error));
    }
  };
  const downloadSecrets = async (item: BackupExport) => {
    if (!props.onDownloadSecrets || secretDownloadId) return;
    setSecretDownloadId(item.id);
    setPrivilegedError(undefined);
    try {
      await props.onDownloadSecrets(item);
      setAnnouncement("Encrypted provider-secret sidecar downloaded.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        // Closing the native save picker is an intentional cancellation, not a failed backup.
        return;
      } else if (isRecentAuthenticationRequired(error)) {
        setPrivilegedError("Sign in again before downloading provider secrets. Redirecting…");
        globalThis.setTimeout(() => props.onReauthenticate?.(), 900);
      } else setPrivilegedError(message(error));
    } finally {
      setSecretDownloadId(undefined);
    }
  };

  useEffect(() => {
    if (preview) restoreHeading.current?.focus();
  }, [preview?.fingerprint]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      uploadController.current?.abort();
      restoreController.current?.abort();
    };
  }, []);

  const selectFile = async (file?: File, retry = false) => {
    const attempt = retry
      ? uploadAttempt.current
      : file
      ? createBackupUploadAttempt(file)
      : undefined;
    if (!attempt) return;
    const epoch = ++operationEpoch.current;
    if (!retry) {
      uploadAttempt.current = attempt;
    }
    uploadController.current?.abort();
    const controller = new AbortController();
    uploadController.current = controller;
    setUpload(undefined);
    setPreview(undefined);
    setCompleted(false);
    setConfirmation("");
    setUploadError(undefined);
    setUploadCancelled(false);
    setPreviewError(undefined);
    setApplyError(undefined);
    setReauthRequired(false);
    setUploadProgress(0);
    try {
      const next = await api.uploadAdminBackupRestore(
        attempt.file,
        attempt.idempotencyKey,
        (percent) => {
          if (mounted.current && operationEpoch.current === epoch) setUploadProgress(percent);
        },
        controller.signal,
      );
      if (!mounted.current || operationEpoch.current !== epoch) return;
      setUpload(next);
      uploadAttempt.current = undefined;
      setUploadProgress(100);
      setAnnouncement(`${attempt.file.name} uploaded. Run the dry check before restoring.`);
    } catch (error) {
      if (!mounted.current || operationEpoch.current !== epoch) return;
      if (error instanceof DOMException && error.name === "AbortError") {
        setUploadCancelled(true);
        setAnnouncement("Upload cancelled. No restore data was changed.");
        requestAnimationFrame(() => dropzone.current?.focus());
      } else setUploadError(message(error));
      setUploadProgress(undefined);
    } finally {
      if (uploadController.current === controller) uploadController.current = undefined;
    }
  };
  const dryRun = async () => {
    if (!upload) return;
    const epoch = operationEpoch.current;
    setPreviewing(true);
    setPreviewError(undefined);
    setPreview(undefined);
    setConfirmation("");
    try {
      const next = await api.previewAdminBackupRestore(upload.id);
      if (!mounted.current || operationEpoch.current !== epoch) return;
      setPreview(next);
      setAnnouncement(
        next.blockingErrors.length
          ? "Dry check completed with blocking errors."
          : "Dry check completed. Review the exact changes before restoring.",
      );
    } catch (error) {
      if (!mounted.current || operationEpoch.current !== epoch) return;
      setPreviewError(message(error));
    } finally {
      if (mounted.current && operationEpoch.current === epoch) setPreviewing(false);
    }
  };
  const apply = async (event: FormEvent) => {
    event.preventDefault();
    if (!preview || confirmation !== preview.fingerprint || preview.blockingErrors.length) return;
    setApplying(true);
    setRestoreStage("Authorizing restore status…");
    setApplyError(undefined);
    restoreController.current?.abort();
    const controller = new AbortController();
    restoreController.current = controller;
    try {
      const capability = await api.issueAdminBackupRestoreStatusCapability(preview.restoreId);
      const outcome = await monitorBackupRestore({
        restoreId: preview.restoreId,
        fingerprint: preview.fingerprint,
        capability,
        signal: controller.signal,
        apply: (signal) =>
          api.applyAdminBackupRestore(preview.restoreId, preview.fingerprint, signal),
        status: (signal) =>
          api.adminBackupRestoreStatus(preview.restoreId, capability.token, signal),
        onStatus: (status) => {
          if (!mounted.current) return;
          setRestoreStage(
            status === "transport-ambiguous"
              ? "Restore response was inconclusive; verifying the durable result…"
              : status.status === "running"
              ? `Restore in progress: ${status.stage.replaceAll("_", " ")}`
              : status.status === "validated"
              ? "Restore is waiting to start"
              : status.status === "completed"
              ? "Restore committed successfully"
              : `Restore failed${status.error ? `: ${status.error}` : ""}`,
          );
        },
      });
      if (!mounted.current) return;
      if (outcome === "failed") {
        throw new Error("The restore failed. Check server logs before retrying.");
      }
      setCompleted(true);
      props.onBaseRestoreCompleted?.(preview.restoreId);
      setAnnouncement("Restore completed. All sessions were invalidated; redirecting to sign in.");
      globalThis.setTimeout(() => props.onReauthenticate?.(), 900);
    } catch (error) {
      if (!mounted.current || (error instanceof DOMException && error.name === "AbortError")) {
        return;
      }
      if (isRecentAuthenticationRequired(error)) {
        // Do not retain typed confirmation material or the validated archive fingerprint while
        // handing control to sign-in. The administrator must dry-run again after authenticating.
        operationEpoch.current += 1;
        setConfirmation("");
        setPreview(undefined);
        setUpload(undefined);
        setReauthRequired(true);
        setAnnouncement("Sign in again before applying this restore.");
        globalThis.setTimeout(() => props.onReauthenticate?.(), 900);
      } else {
        setApplyError(message(error));
      }
    } finally {
      controller.abort();
      if (restoreController.current === controller) restoreController.current = undefined;
      if (mounted.current) setApplying(false);
    }
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (props.restoreEnabled !== true) return;
    void selectFile(event.dataTransfer.files[0]);
  };
  const blocked = !canApplyBackupRestore(
    preview,
    confirmation,
    completed,
    props.restoreEnabled === true,
  );
  const restoreLocked = applying || completed;

  return (
    <section className="backup-page" aria-labelledby={titleId}>
      <p className="ops-announcer" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <header className="ops-heading">
        <div>
          <h1 id={titleId}>Storage &amp; backups</h1>
          <p>
            Create portable exports and validate every restore before it can change this
            installation.
          </p>
        </div>
        <button
          className="primary"
          disabled={props.creating}
          onClick={() => void props.onCreate().catch(() => undefined)}
        >
          <FileArchive size={16} /> {props.creating ? "Starting export…" : "Create backup"}
        </button>
      </header>

      <aside className="backup-safety" aria-label="Sensitive backup handling">
        <ShieldCheck size={20} aria-hidden="true" />
        <div>
          <strong>Backups contain sensitive installation data</strong>
          <p>
            Store every downloaded archive in encrypted, access-controlled storage. Standard exports
            include chats, attachments, account and accounting data, and credential hashes. Request
            and response diagnostics are excluded; provider credentials are redacted and cannot be
            recovered from a standard backup.
          </p>
        </div>
      </aside>
      {props.createError && <p className="backup-alert" role="alert">{props.createError}</p>}

      <section className="backup-card backup-privileged" aria-labelledby="privileged-export-title">
        <div className="backup-section-heading">
          <div>
            <h2 id="privileged-export-title">
              <KeyRound size={18} /> Provider-secret recovery
            </h2>
            <p>Create a separately encrypted credential sidecar for installation recovery.</p>
          </div>
          <span className="ops-status ops-status-failed">highly sensitive</span>
        </div>
        {props.privilegedSecretBackupsEnabled === false
          ? (
            <aside className="backup-warning" role="status">
              <LockKeyhole size={18} aria-hidden="true" />
              <div>
                <strong>Privileged secret backups are disabled</strong>
                <p>
                  An operator must configure the independent recovery keyring and explicitly enable
                  privileged backups. Standard exports remain available and always redact provider
                  credentials.
                </p>
              </div>
            </aside>
          )
          : props.privilegedSecretBackupsEnabled === true
          ? (
            <form className="backup-privileged-form" onSubmit={createPrivileged}>
              <aside className="backup-alert" role="note">
                <AlertTriangle size={18} aria-hidden="true" />
                <div>
                  <strong>The recovery key is not stored in either download</strong>
                  <p>
                    Keep the configured recovery keyring in a separate, encrypted location. A
                    <code>.dgsecrets</code> file is unusable without its exact{" "}
                    <code>.dgbackup</code>
                    partner and recovery key; losing the key permanently loses these credentials.
                    Anyone holding all three can recover provider credentials.
                  </p>
                </div>
              </aside>
              <label htmlFor={`${titleId}-privileged-confirmation`}>
                <strong>Type {PRIVILEGED_BACKUP_CONFIRMATION} to continue</strong>
                <small>
                  Recent authentication is required. The resulting provider-secret file is
                  downloaded separately from the redacted base archive.
                </small>
              </label>
              <div className="backup-privileged-action">
                <input
                  id={`${titleId}-privileged-confirmation`}
                  autoComplete="off"
                  spellCheck={false}
                  value={privilegedConfirmation}
                  onChange={(event) => setPrivilegedConfirmation(event.target.value)}
                  disabled={props.creatingPrivileged}
                />
                <button
                  className="danger"
                  disabled={props.creatingPrivileged ||
                    privilegedConfirmation !== PRIVILEGED_BACKUP_CONFIRMATION}
                >
                  <KeyRound size={15} />
                  {props.creatingPrivileged ? "Starting encrypted export…" : "Create paired export"}
                </button>
              </div>
            </form>
          )
          : <div className="backup-empty" role="status">Checking privileged backup policy…</div>}
        {(privilegedError !== undefined || props.privilegedCreateError !== undefined) && (
          <p className="backup-alert" role="alert">
            {privilegedError ?? message(props.privilegedCreateError)}
          </p>
        )}
      </section>

      <section className="backup-card" aria-labelledby="export-history-title">
        <div className="backup-section-heading">
          <div>
            <h2 id="export-history-title">Export history</h2>
            <p>Downloads are available only after server-side validation completes.</p>
          </div>
          <button className="secondary" onClick={props.onRetry} disabled={props.loading}>
            <RefreshCw size={15} /> Refresh
          </button>
        </div>
        {props.stale && (
          <p className="backup-warning" role="status">Showing saved results; refresh failed.</p>
        )}
        {props.loading && !props.exports.length
          ? <div className="backup-empty" role="status">Loading backup history…</div>
          : props.loadError && !props.exports.length
          ? (
            <div className="backup-empty" role="alert">
              <p>{props.loadError}</p>
              <button className="secondary" onClick={props.onRetry}>Try again</button>
            </div>
          )
          : !props.exports.length
          ? <div className="backup-empty">No exports yet. Create one before a major upgrade.</div>
          : (
            <ul className="backup-export-list">
              {props.exports.map((item) => (
                <li key={item.id}>
                  <span className={`ops-status ops-status-${item.status}`}>{item.status}</span>
                  <div>
                    <strong>
                      <time dateTime={item.createdAt}>
                        {new Date(item.createdAt).toLocaleString()}
                      </time>
                    </strong>
                    <small>
                      Format v{item.formatVersion} · {size(item.bytes)} · secrets redacted
                    </small>
                    {item.providerSecrets && (
                      <small className="backup-secret-summary">
                        <LockKeyhole size={13} aria-hidden="true" /> Encrypted sidecar: {size(
                          item.providerSecrets.bytes,
                        )} · {item.providerSecrets.providerCount ?? "—"} providers · recovery key
                        {" "}
                        {item.providerSecrets.recoveryKeyId ?? "pending"}
                      </small>
                    )}
                    {item.error && <span className="backup-error" role="alert">{item.error}</span>}
                  </div>
                  {item.status === "completed"
                    ? (
                      <div className="backup-downloads">
                        <a
                          className="secondary button-link"
                          href={api.adminBackupContentUrl(item.id)}
                          download
                        >
                          <Download size={15} /> .dgbackup
                        </a>
                        {item.providerSecrets?.status === "completed" && (
                          <button
                            type="button"
                            className="secondary"
                            disabled={secretDownloadId === item.id}
                            onClick={() => void downloadSecrets(item)}
                          >
                            <KeyRound size={15} />
                            {secretDownloadId === item.id ? "Preparing…" : ".dgsecrets"}
                          </button>
                        )}
                      </div>
                    )
                    : item.status === "failed"
                    ? <small>Download unavailable</small>
                    : <progress aria-label="Export progress" className="backup-progress" />}
                </li>
              ))}
            </ul>
          )}
      </section>

      <section
        className="backup-card"
        aria-labelledby="restore-title"
        aria-busy={previewing || applying || undefined}
      >
        <div className="backup-section-heading">
          <div>
            <h2 id="restore-title">Restore from backup</h2>
            <p>Uploading and dry-running never alters application data.</p>
          </div>
        </div>
        {props.restoreEnabled === false && (
          <aside className="backup-warning" role="status">
            <AlertTriangle size={18} aria-hidden="true" />
            <div>
              <strong>In-app restore is disabled by installation policy</strong>
              <p>
                An operator must set <code>ALLOW_IN_APP_RESTORE=true</code>{" "}
                and restart the API before uploads or restore actions are available. Export and
                download remain safe to use.
              </p>
            </div>
          </aside>
        )}
        <input
          ref={picker}
          className="sr-only"
          type="file"
          accept=".dgbackup,application/vnd.dg-chat.backup,application/octet-stream"
          disabled={props.restoreEnabled !== true || restoreLocked}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void selectFile(file);
          }}
        />
        <button
          ref={dropzone}
          type="button"
          className={`backup-dropzone ${dragging ? "dragging" : ""}`}
          disabled={props.restoreEnabled !== true || restoreLocked}
          onClick={() => picker.current?.click()}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDragging(false);
            }
          }}
          onDrop={drop}
        >
          <Upload size={22} aria-hidden="true" />
          <strong>Choose a backup or drop it here</strong>
          <span>
            The server validates format, integrity, ownership references, and attachments.
          </span>
        </button>
        {uploadProgress !== undefined && !upload && (
          <div className="backup-upload-progress">
            <label>
              <span>Uploading… {uploadProgress}%</span>
              <progress value={uploadProgress} max="100" />
            </label>
            <button
              type="button"
              className="secondary"
              onClick={() => uploadController.current?.abort()}
            >
              Cancel upload
            </button>
          </div>
        )}
        {(uploadError || uploadCancelled) && (
          <div className="backup-alert" role="alert">
            <span>
              {uploadCancelled
                ? "Upload cancelled. The selected file can be retried safely."
                : uploadError}
            </span>
            <button
              type="button"
              className="secondary"
              onClick={() => void selectFile(undefined, true)}
            >
              Retry upload
            </button>
          </div>
        )}
        {upload && (
          <div className="backup-uploaded">
            <div>
              <strong>{upload.filename}</strong>
              <small>{size(upload.bytes)} · fingerprint {upload.fingerprint}</small>
            </div>
            <button className="secondary" disabled={previewing} onClick={() => void dryRun()}>
              {previewing ? "Checking…" : preview ? "Run dry check again" : "Run dry check"}
            </button>
          </div>
        )}
        {previewError && <p className="backup-alert" role="alert">{previewError}</p>}
        {reauthRequired && (
          <p className="backup-alert" role="alert">
            Your sign-in is no longer recent enough. Redirecting to sign in; after signing in,
            upload and dry-run the backup again.
          </p>
        )}

        {preview && (
          <form className="backup-preview" onSubmit={apply}>
            <h3 ref={restoreHeading} tabIndex={-1}>Dry-run summary</h3>
            <p>Format v{preview.formatVersion}. No changes have been made.</p>
            {preview.counts.length
              ? (
                <div className="ops-table-scroll">
                  <table className="ops-table">
                    <caption>Proposed record changes</caption>
                    <thead>
                      <tr>
                        <th>Resource</th>
                        <th>Create</th>
                        <th>Update</th>
                        <th>Skip</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.counts.map((row) => (
                        <tr key={row.resource}>
                          <th scope="row">{row.resource}</th>
                          <td>{row.create}</td>
                          <td>{row.update}</td>
                          <td>{row.skip}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
              : <p className="backup-empty">This backup would not change any records.</p>}
            {preview.warnings.length > 0 && (
              <aside className="backup-warning" role="status">
                <AlertTriangle size={18} aria-hidden="true" />
                <div>
                  <strong>Review warnings</strong>
                  <ul>{preview.warnings.map((item) => <li key={item}>{item}</li>)}</ul>
                </div>
              </aside>
            )}
            {preview.blockingErrors.length > 0 && (
              <aside className="backup-alert" role="alert">
                <strong>Restore unavailable</strong>
                <ul>{preview.blockingErrors.map((item) => <li key={item}>{item}</li>)}</ul>
              </aside>
            )}
            {preview.attachmentsMissing > 0 && (
              <p className="backup-warning">
                {preview.attachmentsMissing}{" "}
                attachment objects are missing and must be supplied before restore.
              </p>
            )}
            <div className="backup-confirmation">
              <label htmlFor={`${titleId}-fingerprint`}>
                <strong>Type the exact fingerprint to confirm</strong>
                <small>
                  This binds approval to the file that was dry-run:{" "}
                  <code>{preview.fingerprint}</code>
                </small>
              </label>
              <input
                id={`${titleId}-fingerprint`}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                disabled={restoreLocked || preview.blockingErrors.length > 0}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="none"
                aria-invalid={confirmation.length > 0 && confirmation !== preview.fingerprint}
                aria-describedby={`${titleId}-restore-help`}
              />
              <p id={`${titleId}-restore-help`}>
                {confirmation === preview.fingerprint
                  ? "Fingerprint matches this dry run. Restoring will replace installation data and sign everyone out."
                  : "Restore stays disabled until the fingerprint matches exactly and the dry run has no blocking errors."}
              </p>
              <button className="danger" disabled={blocked || applying}>
                {applying ? "Restoring…" : "Apply transactional restore"}
              </button>
              {applying && restoreStage && <p className="muted" role="status">{restoreStage}</p>}
            </div>
            {applyError && <p className="backup-alert" role="alert">{applyError}</p>}
            {completed && (
              <p className="backup-success" role="status">
                <CheckCircle2 size={18} />{" "}
                Restore completed. Existing sessions were invalidated; redirecting to sign in.
              </p>
            )}
          </form>
        )}
      </section>
      <ProviderSecretRestore
        enabled={props.providerSecretRestoreEnabled}
        initialRestoreId={props.recentRestoreId}
        onReauthenticate={props.onReauthenticate}
        onApplied={props.onProviderSecretsApplied}
      />
    </section>
  );
}
