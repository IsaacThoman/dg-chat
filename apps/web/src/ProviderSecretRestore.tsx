import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, KeyRound, LockKeyhole, Upload } from "lucide-react";
import { api, ApiError } from "./api.ts";
import type {
  ProviderSecretRestorePreview,
  ProviderSecretRestoreState,
  ProviderSecretRestoreUpload,
} from "./types.ts";

export const PROVIDER_SECRET_RESTORE_CONFIRMATION = "RESTORE PROVIDER SECRETS";
export const canApplyProviderSecretRestore = (
  preview: ProviderSecretRestorePreview | undefined,
  confirmation: string,
  applied = false,
) =>
  Boolean(
    preview && !applied && preview.blockingErrors.length === 0 &&
      confirmation === PROVIDER_SECRET_RESTORE_CONFIRMATION,
  );
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "The request failed.";
const isRecentAuthenticationRequired = (error: unknown) =>
  error instanceof ApiError && error.status === 403 &&
  error.code === "recent_authentication_required";
const byteSize = (bytes: number) =>
  new Intl.NumberFormat(undefined, { style: "unit", unit: "byte", notation: "compact" }).format(
    bytes,
  );

export interface ProviderSecretRestoreProps {
  enabled?: boolean;
  initialRestoreId?: string;
  initialState?: ProviderSecretRestoreState;
  onReauthenticate?(): void;
  onApplied?(): void;
}

export function ProviderSecretRestore(props: ProviderSecretRestoreProps) {
  const id = useId();
  const controller = useRef<AbortController | undefined>(undefined);
  const attempt = useRef<{ file: File; restoreId: string; key: string } | undefined>(undefined);
  const reauthTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const [restoreId, setRestoreId] = useState(
    props.initialRestoreId ?? props.initialState?.restoreId ?? "",
  );
  const [upload, setUpload] = useState<ProviderSecretRestoreUpload>();
  const [progress, setProgress] = useState<number>();
  const [uploadError, setUploadError] = useState<string>();
  const [preview, setPreview] = useState<ProviderSecretRestorePreview>();
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string>();
  const [confirmation, setConfirmation] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string>();
  const [applied, setApplied] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [serverState, setServerState] = useState<ProviderSecretRestoreState | undefined>(
    props.initialState,
  );
  const [hydrating, setHydrating] = useState(false);
  const [hydrateError, setHydrateError] = useState<string>();
  const [cancelling, setCancelling] = useState(false);
  const attachmentLocked = Boolean(
    serverState && !["failed", "cancelled"].includes(serverState.status),
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      if (reauthTimer.current !== undefined) clearTimeout(reauthTimer.current);
    };
  }, []);
  useEffect(() => {
    if (props.initialRestoreId && !upload && !applied) setRestoreId(props.initialRestoreId);
  }, [props.initialRestoreId]);

  const applyServerState = (state: ProviderSecretRestoreState | null) => {
    setServerState(state ?? undefined);
    setUpload(undefined);
    setPreview(undefined);
    setApplied(false);
    setConfirmation("");
    if (!state) return;
    if (["uploaded", "validated", "applied"].includes(state.status)) {
      setUpload({
        id: state.id,
        restoreId: state.restoreId,
        status: "uploaded",
        version: state.version,
        filename: state.filename,
        bytes: state.bytes,
        baseFingerprint: state.baseFingerprint,
        sidecarFingerprint: state.sidecarFingerprint,
        recoveryKeyId: state.recoveryKeyId,
        createdAt: state.createdAt,
      });
    }
    if (
      (state.status === "validated" || state.status === "applied") && state.recordCount !== null
    ) {
      setPreview({
        id: state.id,
        restoreId: state.restoreId,
        status: "validated",
        version: state.status === "applied" ? Math.max(1, state.version - 1) : state.version,
        baseFingerprint: state.baseFingerprint,
        sidecarFingerprint: state.sidecarFingerprint,
        recoveryKeyId: state.recoveryKeyId,
        recordCount: state.recordCount,
        providers: state.providers,
        warnings: state.warnings,
        blockingErrors: state.blockingErrors,
        providersRemainDisabled: true,
      });
    }
    setApplied(state.status === "applied");
  };

  const hydrate = async (target: string, announce = false) => {
    if (!UUID.test(target)) return;
    setHydrating(true);
    setHydrateError(undefined);
    try {
      const result = await api.adminProviderSecretRestore(target);
      if (!mounted.current || target !== restoreId) return;
      applyServerState(result.item);
      if (announce && result.item) {
        setAnnouncement(`Recovered provider-secret restore status: ${result.item.status}.`);
      }
    } catch (error) {
      if (!mounted.current || target !== restoreId) return;
      setHydrateError(errorMessage(error));
    } finally {
      if (mounted.current && target === restoreId) setHydrating(false);
    }
  };

  useEffect(() => {
    if (!UUID.test(restoreId)) {
      try {
        globalThis.sessionStorage?.removeItem("dg.provider-secret-restore-id");
      } catch { /* Browser storage can be disabled. */ }
      return;
    }
    try {
      globalThis.sessionStorage?.setItem("dg.provider-secret-restore-id", restoreId);
    } catch {
      // Status remains usable in-memory when browser storage is unavailable.
    }
    void hydrate(restoreId, true);
  }, [restoreId]);
  useEffect(() => {
    if (serverState?.status !== "staging") return;
    const timer = setInterval(() => void hydrate(serverState.restoreId), 2_000);
    return () => clearInterval(timer);
  }, [serverState?.status, serverState?.restoreId]);

  const recentAuth = (error: unknown, action: string) => {
    if (!isRecentAuthenticationRequired(error)) return false;
    attempt.current = undefined;
    setConfirmation("");
    setAnnouncement(`Sign in again before ${action}. Redirecting…`);
    if (reauthTimer.current !== undefined) clearTimeout(reauthTimer.current);
    reauthTimer.current = globalThis.setTimeout(() => props.onReauthenticate?.(), 900);
    return true;
  };
  const resetAttachment = () => {
    controller.current?.abort();
    attempt.current = undefined;
    setUpload(undefined);
    setPreview(undefined);
    setProgress(undefined);
    setUploadError(undefined);
    setPreviewError(undefined);
    setConfirmation("");
    setApplyError(undefined);
    setApplied(false);
    setServerState(undefined);
    setHydrateError(undefined);
  };
  const uploadFile = async (file?: File, retry = false) => {
    const nextAttempt = retry
      ? attempt.current
      : file && UUID.test(restoreId)
      ? { file, restoreId, key: crypto.randomUUID() }
      : undefined;
    if (!nextAttempt) return;
    if (!retry) attempt.current = nextAttempt;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setUpload(undefined);
    setPreview(undefined);
    setProgress(0);
    setUploadError(undefined);
    setPreviewError(undefined);
    setApplyError(undefined);
    setApplied(false);
    try {
      const result = await api.uploadAdminProviderSecretRestore(
        nextAttempt.restoreId,
        nextAttempt.file,
        nextAttempt.key,
        (percent) => {
          if (mounted.current) setProgress(percent);
        },
        nextController.signal,
      );
      if (!mounted.current) return;
      attempt.current = undefined;
      setUpload(result);
      setServerState({
        id: result.id,
        restoreId: result.restoreId,
        status: "uploaded",
        version: result.version,
        filename: "provider-secrets.dgsecrets",
        bytes: result.bytes,
        baseFingerprint: result.baseFingerprint,
        sidecarFingerprint: result.sidecarFingerprint,
        recoveryKeyId: result.recoveryKeyId,
        recordCount: null,
        providers: [],
        warnings: [],
        blockingErrors: [],
        providersRemainDisabled: true,
        error: null,
        createdAt: result.createdAt,
        updatedAt: result.createdAt,
        appliedAt: null,
        expiresAt: null,
        canCancel: true,
      });
      setProgress(100);
      setAnnouncement(
        "Encrypted sidecar uploaded. Run the dry check before restoring credentials.",
      );
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof DOMException && error.name === "AbortError") {
        setUploadError("Upload cancelled. Retry uses the same safe request identity.");
      } else if (!recentAuth(error, "uploading provider secrets")) {
        setUploadError(errorMessage(error));
      }
      setProgress(undefined);
    } finally {
      if (controller.current === nextController) controller.current = undefined;
    }
  };
  const dryRun = async () => {
    if (!upload) return;
    setPreviewing(true);
    setPreviewError(undefined);
    setPreview(undefined);
    setConfirmation("");
    try {
      const result = await api.previewAdminProviderSecretRestore(upload.restoreId, upload.id);
      if (!mounted.current) return;
      setPreview(result);
      setServerState((current) =>
        current
          ? {
            ...current,
            status: result.blockingErrors.length ? "uploaded" : "validated",
            version: result.version,
            recordCount: result.recordCount,
            providers: result.providers,
            warnings: result.warnings,
            blockingErrors: result.blockingErrors,
          }
          : current
      );
      setAnnouncement(
        result.blockingErrors.length
          ? "Provider-secret dry check found blocking errors."
          : "Provider-secret dry check completed. Review every provider before applying.",
      );
    } catch (error) {
      if (!mounted.current) return;
      if (!recentAuth(error, "previewing provider secrets")) setPreviewError(errorMessage(error));
    } finally {
      if (mounted.current) setPreviewing(false);
    }
  };
  const apply = async (event: FormEvent) => {
    event.preventDefault();
    if (!canApplyProviderSecretRestore(preview, confirmation, applied) || !preview || applying) {
      return;
    }
    setApplying(true);
    setApplyError(undefined);
    try {
      const result = await api.applyAdminProviderSecretRestore(preview, confirmation);
      if (!mounted.current) return;
      setApplied(true);
      setServerState((current) =>
        current
          ? {
            ...current,
            status: "applied",
            version: preview.version + 1,
            recordCount: result.providerCount,
            appliedAt: result.appliedAt,
            updatedAt: result.appliedAt,
            expiresAt: null,
            canCancel: false,
          }
          : current
      );
      setConfirmation("");
      setAnnouncement(
        `${result.providerCount} provider credentials restored. Every provider remains disabled.`,
      );
      props.onApplied?.();
    } catch (error) {
      if (!mounted.current) return;
      setConfirmation("");
      if (!recentAuth(error, "restoring provider secrets")) setApplyError(errorMessage(error));
    } finally {
      if (mounted.current) setApplying(false);
    }
  };
  const startOver = async () => {
    if (cancelling) return;
    setCancelling(true);
    setHydrateError(undefined);
    try {
      if (serverState?.canCancel) await api.cancelAdminProviderSecretRestore(serverState);
      resetAttachment();
      setAnnouncement("Provider-secret recovery reset. Choose the matching sidecar again.");
    } catch (error) {
      if (!mounted.current) return;
      if (!recentAuth(error, "starting provider-secret recovery over")) {
        setHydrateError(errorMessage(error));
      }
    } finally {
      if (mounted.current) setCancelling(false);
    }
  };

  return (
    <section className="backup-card backup-secret-restore" aria-labelledby={`${id}-title`}>
      <p className="ops-announcer" role="status" aria-live="polite">{announcement}</p>
      <div className="backup-section-heading">
        <div>
          <h2 id={`${id}-title`}>
            <KeyRound size={18} /> Restore encrypted provider secrets
          </h2>
          <p>
            Attach a <code>.dgsecrets</code> sidecar only after its exact base restore completed.
          </p>
        </div>
        <span className="ops-status ops-status-failed">credentials remain disabled</span>
      </div>
      {props.enabled === false
        ? (
          <aside className="backup-warning" role="status">
            <LockKeyhole size={18} aria-hidden="true" />
            <div>
              <strong>Provider-secret restore is disabled</strong>
              <p>
                Configure the destination recovery keyring and enable provider-secret restore. Base
                backup restore remains available; no provider credentials can be imported.
              </p>
            </div>
          </aside>
        )
        : props.enabled === undefined
        ? <div className="backup-empty" role="status">Checking provider-secret restore policy…</div>
        : (
          <>
            <aside className="backup-warning" role="note">
              <AlertTriangle size={18} aria-hidden="true" />
              <div>
                <strong>Exact pairing and recovery key required</strong>
                <p>
                  The server rejects a sidecar from any other backup. Restored credentials are
                  re-encrypted for this installation and every provider stays disabled until an
                  administrator tests and enables it.
                </p>
              </div>
            </aside>
            <label className="backup-restore-target" htmlFor={`${id}-restore-id`}>
              <strong>Completed base restore ID</strong>
              <input
                id={`${id}-restore-id`}
                value={restoreId}
                spellCheck={false}
                autoComplete="off"
                placeholder="00000000-0000-4000-8000-000000000000"
                disabled={attachmentLocked || applying || applied}
                onChange={(event) => {
                  resetAttachment();
                  setRestoreId(event.target.value.trim());
                }}
              />
              {!UUID.test(restoreId) && restoreId.length > 0 && (
                <small>Enter a valid restore ID.</small>
              )}
            </label>
            {hydrating && (
              <p className="backup-empty" role="status">
                Checking for an existing provider-secret restore…
              </p>
            )}
            {hydrateError && (
              <p className="backup-alert" role="alert">
                <span>{hydrateError}</span>
                <button className="secondary" type="button" onClick={() => void hydrate(restoreId)}>
                  Check status again
                </button>
              </p>
            )}
            {serverState?.status === "staging" && (
              <aside className="backup-warning" role="status">
                <div>
                  <strong>Recovering an interrupted upload</strong>
                  <p>
                    The encrypted sidecar is being reconciled with durable storage. This page checks
                    automatically; start over if the original upload cannot finish.
                  </p>
                </div>
              </aside>
            )}
            {serverState && ["failed", "cancelled"].includes(serverState.status) && (
              <aside className="backup-alert" role="alert">
                <div>
                  <strong>
                    {serverState.status === "failed"
                      ? "The previous provider-secret restore failed"
                      : "The previous provider-secret restore expired or was cancelled"}
                  </strong>
                  <p>
                    {serverState.error ??
                      "Its encrypted staging object is no longer eligible to be restored."}
                  </p>
                </div>
              </aside>
            )}
            {serverState?.expiresAt &&
              !["applied", "failed", "cancelled"].includes(serverState.status) && (
              <p className="backup-warning" role="status">
                This recovery state expires{" "}
                <time dateTime={serverState.expiresAt}>
                  {new Date(serverState.expiresAt).toLocaleString()}
                </time>.
              </p>
            )}
            {serverState && serverState.status !== "applied" &&
              (serverState.canCancel || ["failed", "cancelled"].includes(serverState.status)) && (
              <button
                type="button"
                className="secondary backup-start-over"
                disabled={cancelling}
                onClick={() => void startOver()}
              >
                {cancelling
                  ? "Resetting recovery…"
                  : serverState.canCancel
                  ? "Start over with another sidecar"
                  : "Choose another sidecar"}
              </button>
            )}
            <label
              className={`backup-secret-picker ${
                !UUID.test(restoreId) || attachmentLocked || hydrating ? "disabled" : ""
              }`}
            >
              <Upload size={20} aria-hidden="true" />
              <strong>Choose the matching .dgsecrets file</strong>
              <span>The encrypted file is validated before any credential can change.</span>
              <input
                className="sr-only"
                type="file"
                accept=".dgsecrets,application/vnd.dg-chat.provider-secrets,application/octet-stream"
                disabled={!UUID.test(restoreId) || attachmentLocked || hydrating || applying ||
                  applied}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  void uploadFile(file);
                }}
              />
            </label>
            {progress !== undefined && !upload && (
              <div className="backup-upload-progress">
                <label>
                  <span>Uploading encrypted sidecar… {progress}%</span>
                  <progress value={progress} max="100" />
                </label>
                <button className="secondary" onClick={() => controller.current?.abort()}>
                  Cancel upload
                </button>
              </div>
            )}
            {uploadError && (
              <p className="backup-alert" role="alert">
                <span>{uploadError}</span>
                {attempt.current && (
                  <button
                    className="secondary"
                    onClick={() => void uploadFile(undefined, true)}
                  >
                    Retry upload
                  </button>
                )}
              </p>
            )}
            {upload && (
              <div className="backup-uploaded">
                <div>
                  <strong>{upload.filename}</strong>
                  <small>{byteSize(upload.bytes)} · recovery key {upload.recoveryKeyId}</small>
                  <small>Base {upload.baseFingerprint} · sidecar {upload.sidecarFingerprint}</small>
                </div>
                <button className="secondary" disabled={previewing} onClick={() => void dryRun()}>
                  {previewing ? "Checking…" : preview ? "Run dry check again" : "Run dry check"}
                </button>
              </div>
            )}
            {previewError && <p className="backup-alert" role="alert">{previewError}</p>}
            {preview && (
              <form className="backup-preview" onSubmit={apply}>
                <h3>Provider impact</h3>
                <p>
                  {preview.recordCount} encrypted credential records. No changes have been made.
                </p>
                <div className="ops-table-scroll">
                  <table className="ops-table">
                    <thead>
                      <tr>
                        <th>Provider</th>
                        <th>Action</th>
                        <th>Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.providers.map((provider) => (
                        <tr key={provider.providerId}>
                          <th scope="row">{provider.displayName}</th>
                          <td>
                            <span
                              className={`ops-status ops-status-${
                                provider.action === "restore"
                                  ? "completed"
                                  : provider.action === "skip"
                                  ? "queued"
                                  : "failed"
                              }`}
                            >
                              {provider.action}
                            </span>
                          </td>
                          <td>
                            {provider.reason ??
                              "Credential will be restored; provider remains disabled."}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {preview.warnings.length > 0 && (
                  <aside className="backup-warning" role="status">
                    <div>
                      <strong>Review warnings</strong>
                      <ul>{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
                    </div>
                  </aside>
                )}
                {preview.blockingErrors.length > 0 && (
                  <aside className="backup-alert" role="alert">
                    <div>
                      <strong>Restore unavailable</strong>
                      <ul>
                        {preview.blockingErrors.map((failure) => <li key={failure}>{failure}</li>)}
                      </ul>
                    </div>
                  </aside>
                )}
                <div className="backup-confirmation">
                  <label htmlFor={`${id}-confirmation`}>
                    <strong>Type {PROVIDER_SECRET_RESTORE_CONFIRMATION} to apply</strong>
                    <small>
                      Approval is bound to both displayed fingerprints and preview version{" "}
                      {preview.version}.
                    </small>
                  </label>
                  <input
                    id={`${id}-confirmation`}
                    value={confirmation}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={applying || applied || preview.blockingErrors.length > 0}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                  <button
                    className="danger"
                    disabled={applying ||
                      !canApplyProviderSecretRestore(preview, confirmation, applied)}
                  >
                    <KeyRound size={15} /> {applying
                      ? "Restoring credentials…"
                      : applied
                      ? "Credentials restored"
                      : "Restore provider secrets"}
                  </button>
                </div>
                {applyError && <p className="backup-alert" role="alert">{applyError}</p>}
                {applied && (
                  <p className="backup-success" role="status">
                    Credentials restored and re-encrypted. All affected providers remain disabled.
                  </p>
                )}
              </form>
            )}
          </>
        )}
    </section>
  );
}
