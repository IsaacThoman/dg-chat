import { type FormEvent, useState } from "react";
import { RefreshCw } from "lucide-react";
import { ApiError } from "../../api.ts";
import { Modal } from "../../Modal.tsx";

export const dateTime = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString() : "Never";

export const errorMessage = (error: unknown, fallback: string) =>
  error instanceof ApiError || error instanceof Error ? error.message : fallback;

export const isConflict = (error: unknown) =>
  error instanceof ApiError && ["version_conflict", "balance_conflict"].includes(error.code);

export const requiresRecentAuth = (error: unknown) =>
  error instanceof ApiError && error.code === "recent_authentication_required";

export function DetailState(
  { kind, message, retry }: {
    kind: "loading" | "empty" | "error";
    message: string;
    retry?: () => void;
  },
) {
  return (
    <div
      className={`admin-user-detail-state ${kind}`}
      role={kind === "error" ? "alert" : "status"}
    >
      {kind === "loading" && <RefreshCw className="spin" size={18} aria-hidden="true" />}
      <p>{message}</p>
      {retry && (
        <button type="button" className="secondary" onClick={retry}>
          <RefreshCw size={15} aria-hidden="true" /> Retry
        </button>
      )}
    </div>
  );
}

export function ReasonDialog(
  { title, consequence, confirmLabel, danger = true, close, submit, onReauthenticate }: {
    title: string;
    consequence: string;
    confirmLabel: string;
    danger?: boolean;
    close(): void;
    submit(reason: string): Promise<void>;
    onReauthenticate(): void;
  },
) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reauth, setReauth] = useState(false);
  const [reviewRequired, setReviewRequired] = useState(false);
  const perform = async (event: FormEvent) => {
    event.preventDefault();
    if (!reason.trim()) return;
    setBusy(true);
    setError("");
    setReauth(false);
    setReviewRequired(false);
    try {
      await submit(reason.trim());
      close();
    } catch (cause) {
      if (requiresRecentAuth(cause)) {
        setReason("");
        setReauth(true);
        setError("A fresh administrator sign-in is required before this security action.");
      } else if (isConflict(cause)) {
        setReviewRequired(true);
        setError(
          "This resource changed elsewhere. We refreshed it; review the latest state before retrying.",
        );
      } else {
        setError(errorMessage(cause, "The action could not be completed."));
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={title} close={close} dismissible={!busy} variant="medium">
      <form className="admin-user-reason-form" onSubmit={perform} aria-busy={busy}>
        <p className="admin-user-consequence">{consequence}</p>
        <label>
          <span>Reason</span>
          <textarea
            data-autofocus
            required
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Record why this change is needed"
          />
          <small>{reason.length}/500 · saved to the audit log</small>
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        {reauth && (
          <button type="button" className="secondary" onClick={onReauthenticate}>
            Sign in again
          </button>
        )}
        {reviewRequired && (
          <button
            type="button"
            className="secondary"
            onClick={() => setReviewRequired(false)}
          >
            I reviewed the latest state
          </button>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className={danger ? "danger-button" : "primary"}
            disabled={busy || !reason.trim() || reauth || reviewRequired}
          >
            {busy ? "Saving…" : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function Pagination(
  { page, previous, next, fetching, hasNext }: {
    page: number;
    previous(): void;
    next(): void;
    fetching: boolean;
    hasNext: boolean;
  },
) {
  return (
    <nav className="admin-user-detail-pagination" aria-label="Result pages">
      <button
        type="button"
        className="secondary"
        disabled={page === 1 || fetching}
        onClick={previous}
      >
        ‹ Previous
      </button>
      <span>Page {page}</span>
      <button
        type="button"
        className="secondary"
        disabled={!hasNext || fetching}
        onClick={next}
      >
        Next ›
      </button>
    </nav>
  );
}
