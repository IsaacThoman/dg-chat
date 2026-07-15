import { type FormEvent, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleDollarSign } from "lucide-react";
import type {
  AdminLedgerKind,
  AdminLedgerQuery,
  AdminUser,
} from "../../../../../packages/contracts/src/types.ts";
import { api, ApiError } from "../../api.ts";
import { Modal } from "../../Modal.tsx";
import { adminUserKeys } from "./adminUserKeys.ts";
import { formatUsdMicros, parseUsdMicros } from "./money.ts";
import {
  dateTime,
  DetailState,
  errorMessage,
  isConflict,
  Pagination,
  requiresRecentAuth,
} from "./AdminUserPrimitives.tsx";

const PAGE_SIZE = 25;
function AdjustmentDialog(
  { user, close, saved, refresh, refreshLedger, onReauthenticate }: {
    user: AdminUser;
    close(): void;
    saved(message: string): void;
    refresh(): Promise<unknown>;
    refreshLedger(): Promise<unknown>;
    onReauthenticate(): void;
  },
) {
  const client = useQueryClient();
  const key = useRef(crypto.randomUUID());
  const [direction, setDirection] = useState<"credit" | "debit">("credit");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reauth, setReauth] = useState(false);
  const [reviewRequired, setReviewRequired] = useState(false);
  const parsed = parseUsdMicros(amount, { minimumMicros: 1 });
  const signedAmount = parsed.ok ? (direction === "credit" ? parsed.micros : -parsed.micros) : 0;
  const resultingBalance = user.balanceMicros + signedAmount;
  const resultSafe = Number.isSafeInteger(resultingBalance) && resultingBalance >= 0;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!parsed.ok || !resultSafe || !reason.trim()) return;
    setBusy(true);
    setError("");
    setReauth(false);
    setReviewRequired(false);
    try {
      const result = await api.adjustAdminUserBalance(user.id, {
        amountMicros: signedAmount,
        expectedBalanceMicros: user.balanceMicros,
        reason: reason.trim(),
      }, key.current);
      await Promise.all([refresh(), refreshLedger()]);
      await Promise.all([
        client.invalidateQueries({ queryKey: adminUserKeys.directories() }),
        client.invalidateQueries({ queryKey: ["admin-usage"] }),
        client.invalidateQueries({ queryKey: ["admin-analytics"] }),
      ]);
      key.current = crypto.randomUUID();
      saved(
        `${result.replayed ? "Previously completed" : "Completed"} adjustment: ${
          formatUsdMicros(result.amountMicros, { showPlus: true })
        }.`,
      );
      close();
    } catch (cause) {
      if (requiresRecentAuth(cause)) {
        setAmount("");
        setReason("");
        setReauth(true);
        setError("A fresh administrator sign-in is required. This draft was cleared.");
      } else if (isConflict(cause)) {
        await Promise.all([refresh(), refreshLedger()]);
        setReviewRequired(true);
        setError(
          "The balance changed elsewhere. We loaded the latest balance; review the new result before retrying.",
        );
      } else if (cause instanceof ApiError && cause.code === "idempotency_conflict") {
        setError(
          "This adjustment key was already used for different details. Close this dialog and start a new adjustment.",
        );
      } else {
        setError(
          "The result could not be confirmed. Do not submit a second adjustment; retry this same draft or refresh the ledger first.",
        );
      }
    } finally {
      setBusy(false);
    }
  };
  const amountError = amount && !parsed.ok
    ? parsed.error === "too_precise"
      ? "Use no more than six decimal places."
      : "Enter a positive USD amount."
    : !resultSafe
    ? "This debit would make the balance negative or unsafe."
    : "";
  return (
    <Modal title="Adjust balance" close={close} dismissible={!busy} variant="medium">
      <form className="admin-user-adjustment" onSubmit={submit} aria-busy={busy}>
        <fieldset>
          <legend>Adjustment type</legend>
          <div className="admin-user-segmented">
            <label>
              <input
                type="radio"
                name="direction"
                checked={direction === "credit"}
                onChange={() => setDirection("credit")}
              />{" "}
              Credit
            </label>
            <label>
              <input
                type="radio"
                name="direction"
                checked={direction === "debit"}
                onChange={() => setDirection("debit")}
              />{" "}
              Debit
            </label>
          </div>
        </fieldset>
        <label>
          <span>Amount (USD)</span>
          <input
            data-autofocus
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0.00"
            aria-describedby="admin-adjustment-amount-help"
          />
          <small id="admin-adjustment-amount-help">Exact to six decimal places.</small>
        </label>
        {amountError && <p className="form-error" role="alert">{amountError}</p>}
        <dl className="admin-user-adjustment-preview">
          <div>
            <dt>Current balance</dt>
            <dd>{formatUsdMicros(user.balanceMicros)}</dd>
          </div>
          <div>
            <dt>Resulting balance</dt>
            <dd>{parsed.ok && resultSafe ? formatUsdMicros(resultingBalance) : "—"}</dd>
          </div>
        </dl>
        <label>
          <span>Reason</span>
          <textarea
            required
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Record why this adjustment is needed"
          />
          <small>{reason.length}/500 · saved to the immutable ledger and audit log</small>
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
            I reviewed the latest balance and ledger
          </button>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className={direction === "debit" ? "danger-button" : "primary"}
            disabled={busy || !parsed.ok || !resultSafe || !reason.trim() || reauth ||
              reviewRequired}
          >
            {busy ? "Confirming…" : direction === "credit" ? "Add credit" : "Debit balance"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function AdminUserBillingTab(
  { user, refresh, onReauthenticate, announce }: {
    user: AdminUser;
    refresh(): Promise<unknown>;
    onReauthenticate(): void;
    announce(message: string): void;
  },
) {
  const [kind, setKind] = useState<AdminLedgerKind>();
  const [cursors, setCursors] = useState<string[]>([]);
  const [adjusting, setAdjusting] = useState(false);
  const cursor = cursors.at(-1);
  const filters = { kind, cursor, limit: PAGE_SIZE } satisfies AdminLedgerQuery;
  const ledger = useQuery({
    queryKey: adminUserKeys.ledger(user.id, filters),
    queryFn: ({ signal }) => api.adminUserLedger(user.id, filters, signal),
  });
  return (
    <section className="admin-user-tab-stack" aria-labelledby="admin-user-billing-heading">
      <div className="admin-user-balance-hero">
        <div>
          <p>AVAILABLE BALANCE</p>
          <strong>{formatUsdMicros(user.balanceMicros)}</strong>
          <small>Credits are enforced across web and API requests.</small>
        </div>
        <button type="button" className="primary" onClick={() => setAdjusting(true)}>
          <CircleDollarSign size={16} /> Adjust balance
        </button>
      </div>
      <div className="admin-user-tab-heading">
        <div>
          <h2 id="admin-user-billing-heading">Ledger</h2>
          <p>Append-only grants, reservations, settlements, refunds, and adjustments.</p>
        </div>
        <div className="admin-user-billing-tools">
          <a className="secondary" href={`/admin/usage?userId=${encodeURIComponent(user.id)}`}>
            View usage analytics
          </a>
          <label>
            <span>Kind</span>
            <select
              value={kind ?? ""}
              onChange={(event) => {
                setKind(event.target.value as AdminLedgerKind || undefined);
                setCursors([]);
              }}
            >
              <option value="">All entries</option>
              <option value="grant">Grant</option>
              <option value="reserve">Reserve</option>
              <option value="settle">Settle</option>
              <option value="refund">Refund</option>
              <option value="adjustment">Adjustment</option>
            </select>
          </label>
        </div>
      </div>
      {ledger.isLoading && <DetailState kind="loading" message="Loading ledger entries…" />}
      {ledger.isError && !ledger.data && (
        <DetailState
          kind="error"
          message={errorMessage(ledger.error, "The ledger is unavailable.")}
          retry={() => void ledger.refetch()}
        />
      )}
      {ledger.isError && ledger.data && (
        <p className="admin-user-stale-warning" role="status">
          The latest ledger refresh failed. Showing the last loaded data.{"  "}
          <button type="button" className="text-button" onClick={() => void ledger.refetch()}>
            Retry
          </button>
        </p>
      )}
      {!ledger.isLoading && ledger.data?.data.length === 0 && (
        <DetailState kind="empty" message="No ledger entries match this view." />
      )}
      {!!ledger.data?.data.length && (
        <div className="admin-user-ledger-wrap" aria-busy={ledger.isFetching}>
          <table className="admin-user-ledger">
            <caption className="sr-only">Account ledger entries</caption>
            <thead>
              <tr>
                <th>Time</th>
                <th>Kind</th>
                <th>Amount</th>
                <th>Balance after</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {ledger.data.data.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <time dateTime={entry.createdAt}>{dateTime(entry.createdAt)}</time>
                  </td>
                  <td>
                    <span className="status-chip">{entry.kind}</span>
                  </td>
                  <td className={entry.amountMicros < 0 ? "negative" : "positive"}>
                    {formatUsdMicros(entry.amountMicros, { showPlus: true })}
                  </td>
                  <td>{formatUsdMicros(entry.balanceAfterMicros)}</td>
                  <td>
                    {entry.adjustment
                      ? (
                        <span>
                          <strong>{entry.adjustment.reason}</strong>
                          <small>Administrator {entry.adjustment.actorId}</small>
                        </span>
                      )
                      : <code title={entry.usageRunId}>{entry.usageRunId}</code>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {ledger.data && (cursors.length > 0 || ledger.data.nextCursor) && (
        <Pagination
          page={cursors.length + 1}
          fetching={ledger.isFetching}
          hasNext={Boolean(ledger.data.nextCursor)}
          previous={() => setCursors((value) => value.slice(0, -1))}
          next={() =>
            ledger.data?.nextCursor && setCursors((value) => [...value, ledger.data!.nextCursor!])}
        />
      )}
      {adjusting && (
        <AdjustmentDialog
          user={user}
          close={() => setAdjusting(false)}
          saved={announce}
          refresh={refresh}
          refreshLedger={ledger.refetch}
          onReauthenticate={onReauthenticate}
        />
      )}
    </section>
  );
}
