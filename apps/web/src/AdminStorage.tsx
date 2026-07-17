import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FileArchive, HardDrive, RefreshCw, Users } from "lucide-react";
import type {
  AdminAttachmentDeletionFilter,
  AdminAttachmentPage,
  AdminAttachmentQuery,
  AdminAttachmentState,
  AdminAttachmentSummary,
  AdminStorageSummary,
} from "../../../packages/contracts/src/types.ts";
import { api, ApiError } from "./api.ts";
import { Modal } from "./Modal.tsx";

const states: Array<"" | AdminAttachmentState> = [
  "",
  "pending",
  "inspecting",
  "ready",
  "quarantined",
  "failed",
  "deleted",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface StorageFilters {
  ownerId: string;
  state: "" | AdminAttachmentState;
  deletion: AdminAttachmentDeletionFilter;
}

export function boundedStorageFilters(filters: StorageFilters): StorageFilters {
  return {
    ownerId: filters.ownerId.trim().slice(0, 36),
    state: states.includes(filters.state) ? filters.state : "",
    deletion: ["present", "deleted", "all"].includes(filters.deletion)
      ? filters.deletion
      : "present",
  };
}

export function attachmentMatchesAdminQuery(
  attachment: AdminAttachmentSummary,
  query: AdminAttachmentQuery,
): boolean {
  if (query.ownerId && attachment.ownerId !== query.ownerId) return false;
  if (query.state && attachment.state !== query.state) return false;
  if (query.deletion === "present" && attachment.deletedAt) return false;
  if (query.deletion === "deleted" && !attachment.deletedAt) return false;
  return true;
}

export function reconcileReinspectedAttachment(
  page: AdminAttachmentPage | undefined,
  query: AdminAttachmentQuery,
  attachment: AdminAttachmentSummary,
): AdminAttachmentPage | undefined {
  if (!page) return page;
  return {
    ...page,
    data: page.data.flatMap((item) =>
      item.id !== attachment.id
        ? [item]
        : attachmentMatchesAdminQuery(attachment, query)
        ? [attachment]
        : []
    ),
  };
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Storage information is temporarily unavailable.";
const bytes = (value: number) =>
  new Intl.NumberFormat(undefined, {
    style: "unit",
    unit: "byte",
    unitDisplay: "narrow",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
const timestamp = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );

export function AdminStorageView({ onReauthenticate }: { onReauthenticate?: () => void }) {
  const client = useQueryClient();
  const [filters, setFilters] = useState<StorageFilters>({
    ownerId: "",
    state: "",
    deletion: "present",
  });
  const [cursor, setCursor] = useState<string>();
  const [history, setHistory] = useState<Array<string | undefined>>([]);
  const query: AdminAttachmentQuery = {
    ...(filters.ownerId ? { ownerId: filters.ownerId } : {}),
    ...(filters.state ? { state: filters.state } : {}),
    deletion: filters.deletion,
    cursor,
    limit: 25,
  };
  const summary = useQuery({
    queryKey: ["admin-storage-summary"],
    queryFn: api.adminStorageSummary,
  });
  const inventory = useQuery({
    queryKey: ["admin-storage-attachments", query],
    queryFn: () => api.adminAttachments(query),
  });
  const reinspect = useMutation({
    mutationFn: ({ attachment, reason }: {
      attachment: AdminAttachmentSummary;
      reason: string;
    }) => api.reinspectAdminAttachment(attachment, reason),
    onSuccess: async ({ attachment }) => {
      client.setQueryData<AdminAttachmentPage>(
        ["admin-storage-attachments", query],
        (page) => reconcileReinspectedAttachment(page, query, attachment),
      );
      await Promise.all([
        client.invalidateQueries({ queryKey: ["admin-storage-summary"] }),
        client.invalidateQueries({ queryKey: ["admin-storage-attachments"] }),
      ]);
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) {
        await client.invalidateQueries({ queryKey: ["admin-storage-attachments"] });
      }
    },
  });
  return (
    <AdminStorage
      summary={summary.data}
      summaryLoading={summary.isLoading}
      summaryError={summary.isError ? errorMessage(summary.error) : undefined}
      page={inventory.data}
      inventoryLoading={inventory.isLoading || inventory.isFetching}
      inventoryError={inventory.isError ? errorMessage(inventory.error) : undefined}
      filters={filters}
      hasPrevious={history.length > 0}
      reinspectionId={reinspect.isPending ? reinspect.variables?.attachment.id : undefined}
      reinspectionError={reinspect.isError ? errorMessage(reinspect.error) : undefined}
      reinspectionConflict={reinspect.error instanceof ApiError && reinspect.error.status === 409}
      reinspectionRecentAuth={reinspect.error instanceof ApiError &&
        reinspect.error.code === "recent_authentication_required"}
      onApply={(next) => {
        setFilters(next);
        setCursor(undefined);
        setHistory([]);
      }}
      onRetrySummary={() => void summary.refetch()}
      onRetryInventory={() => void inventory.refetch()}
      onNext={(next) => {
        setHistory((value) => [...value, cursor]);
        setCursor(next);
      }}
      onPrevious={() => {
        setHistory((value) => {
          const next = [...value];
          setCursor(next.pop());
          return next;
        });
      }}
      onReinspect={(attachment, reason) =>
        reinspect.mutateAsync({ attachment, reason }).then(() => undefined)}
      onResetReinspection={() => reinspect.reset()}
      onReauthenticate={onReauthenticate}
    />
  );
}

export interface AdminStorageProps {
  summary?: AdminStorageSummary;
  summaryLoading?: boolean;
  summaryError?: string;
  page?: AdminAttachmentPage;
  inventoryLoading?: boolean;
  inventoryError?: string;
  filters: StorageFilters;
  hasPrevious: boolean;
  reinspectionId?: string;
  reinspectionError?: string;
  reinspectionConflict?: boolean;
  reinspectionRecentAuth?: boolean;
  onApply(filters: StorageFilters): void;
  onRetrySummary(): void;
  onRetryInventory(): void;
  onNext(cursor: string): void;
  onPrevious(): void;
  onReinspect(attachment: AdminAttachmentSummary, reason: string): Promise<void>;
  onResetReinspection(): void;
  onReauthenticate?: () => void;
}

export function AdminStorage(props: AdminStorageProps) {
  const headingId = useId();
  const [draft, setDraft] = useState(props.filters);
  const [selected, setSelected] = useState<AdminAttachmentSummary>();
  const [reason, setReason] = useState("");
  const actionRef = useRef<HTMLDivElement>(null);
  useEffect(() => setDraft(props.filters), [
    props.filters.ownerId,
    props.filters.state,
    props.filters.deletion,
  ]);
  const apply = (event: FormEvent) => {
    event.preventDefault();
    const next = boundedStorageFilters(draft);
    if (next.ownerId && !UUID.test(next.ownerId)) return;
    props.onApply(next);
  };
  const openReinspection = (attachment: AdminAttachmentSummary) => {
    props.onResetReinspection();
    setReason("");
    setSelected(attachment);
  };
  const closeReinspection = () => {
    if (selected && props.reinspectionId === selected.id) return;
    setSelected(undefined);
    setReason("");
    props.onResetReinspection();
  };
  const cards = props.summary
    ? [
      {
        label: "Installation bytes",
        value: props.summary.installationBytesLimit == null
          ? bytes(props.summary.physicalBytes)
          : `${bytes(props.summary.physicalBytes)} / ${
            bytes(props.summary.installationBytesLimit)
          }`,
        detail: props.summary.installationBytesLimit == null
          ? "No configured limit reported"
          : (props.summary.installationBytesOverage ?? 0) > 0
          ? `${
            props.summary.installationBytesPercent == null
              ? "Over limit"
              : `${props.summary.installationBytesPercent.toFixed(1)}% used`
          } · ${bytes(props.summary.installationBytesOverage ?? 0)} over limit`
          : `${props.summary.installationBytesPercent?.toFixed(1) ?? "0.0"}% used · ${
            bytes(props.summary.installationBytesRemaining ?? 0)
          } remaining`,
        icon: HardDrive,
      },
      {
        label: "Installation objects",
        value: props.summary.installationObjectsLimit == null
          ? props.summary.physicalObjects.toLocaleString()
          : `${props.summary.physicalObjects.toLocaleString()} / ${props.summary.installationObjectsLimit.toLocaleString()}`,
        detail: props.summary.installationObjectsLimit == null
          ? "No configured limit reported"
          : (props.summary.installationObjectsOverage ?? 0) > 0
          ? `${
            props.summary.installationObjectsPercent == null
              ? "Over limit"
              : `${props.summary.installationObjectsPercent.toFixed(1)}% used`
          } · ${(props.summary.installationObjectsOverage ?? 0).toLocaleString()} over limit`
          : `${props.summary.installationObjectsPercent?.toFixed(1) ?? "0.0"}% used · ${
            (props.summary.installationObjectsRemaining ?? 0).toLocaleString()
          } remaining`,
        icon: FileArchive,
      },
      {
        label: "Owners with storage",
        value: props.summary.ownersWithStorage.toLocaleString(),
        detail: props.summary.perUserBytesLimit == null
          ? "Per-user limit unavailable"
          : `${bytes(props.summary.perUserBytesLimit)} and ${
            (props.summary.perUserObjectsLimit ?? 0).toLocaleString()
          } objects per user`,
        icon: Users,
      },
      {
        label: "Quarantined",
        value: props.summary.quarantinedRecords.toLocaleString(),
        detail: "Active records awaiting policy resolution",
        icon: AlertTriangle,
      },
    ]
    : [];
  return (
    <section className="storage-admin" aria-labelledby={headingId}>
      <header className="ops-heading">
        <div>
          <h1 id={headingId}>Attachment storage</h1>
          <p>
            Review retained physical usage and send suspicious files through the current inspection
            policy.
          </p>
        </div>
        <button className="secondary ops-target" onClick={props.onRetrySummary}>
          <RefreshCw size={16} aria-hidden="true" /> Refresh summary
        </button>
      </header>

      <div
        className="ops-announcer"
        role={props.summaryError && !props.summary ? "alert" : "status"}
        aria-live="polite"
      >
        {props.summaryLoading
          ? "Loading storage summary…"
          : props.summaryError
          ? props.summary ? `Showing an older summary. ${props.summaryError}` : props.summaryError
          : ""}
      </div>
      {props.summaryError && !props.summary && (
        <button className="secondary ops-target" onClick={props.onRetrySummary}>
          Retry loading summary
        </button>
      )}
      {cards.length > 0 && (
        <dl className="storage-summary-grid" aria-label="Installation storage summary">
          {cards.map(({ label, value, detail, icon: Icon }) => (
            <div className="storage-summary-card" key={label}>
              <dt>
                <Icon size={17} aria-hidden="true" /> {label}
              </dt>
              <dd>{value}</dd>
              <small>{detail}</small>
            </div>
          ))}
        </dl>
      )}
      {props.summary && (
        <p className="storage-retention-note">
          Deleted attachment records: {props.summary.deletedRecords.toLocaleString()}{" "}
          · Active records:{" "}
          {props.summary.activeRecords.toLocaleString()}. Soft deletion does not reclaim retained
          physical capacity.
        </p>
      )}

      <div className="storage-inventory-heading">
        <div>
          <h2>Attachment inventory</h2>
          <p>Object-store keys and credentials are never displayed.</p>
        </div>
      </div>
      <form
        className="ops-filters storage-filters"
        aria-label="Attachment filters"
        onSubmit={apply}
      >
        <label>
          Owner ID
          <input
            value={draft.ownerId}
            maxLength={36}
            placeholder="All owners"
            aria-invalid={Boolean(draft.ownerId && !UUID.test(draft.ownerId))}
            onChange={(event) => setDraft({ ...draft, ownerId: event.target.value })}
          />
        </label>
        <label>
          State
          <select
            value={draft.state}
            onChange={(event) =>
              setDraft({ ...draft, state: event.target.value as StorageFilters["state"] })}
          >
            <option value="">All states</option>
            {states.filter(Boolean).map((state) => <option key={state}>{state}</option>)}
          </select>
        </label>
        <label>
          Records
          <select
            value={draft.deletion}
            onChange={(event) =>
              setDraft({
                ...draft,
                deletion: event.target.value as AdminAttachmentDeletionFilter,
              })}
          >
            <option value="present">Active only</option>
            <option value="deleted">Deleted only</option>
            <option value="all">Active and deleted</option>
          </select>
        </label>
        <button
          className="primary ops-target"
          type="submit"
          disabled={Boolean(draft.ownerId && !UUID.test(draft.ownerId))}
        >
          Apply filters
        </button>
      </form>

      <div
        ref={actionRef}
        className="ops-announcer"
        role={props.inventoryError && !props.page ? "alert" : "status"}
        aria-live="polite"
        tabIndex={-1}
      >
        {props.inventoryLoading
          ? "Loading attachment inventory…"
          : props.inventoryError
          ? props.page ? `Showing older results. ${props.inventoryError}` : props.inventoryError
          : ""}
      </div>
      {props.inventoryError && !props.page && (
        <button className="secondary ops-target" onClick={props.onRetryInventory}>
          Retry loading attachments
        </button>
      )}
      {props.page?.data.length === 0 && (
        <p className="ops-empty" role="status">No attachments match these filters.</p>
      )}
      {props.page && props.page.data.length > 0 && (
        <div className="storage-table-wrap">
          <table className="storage-table">
            <caption className="sr-only">Filtered attachment inventory</caption>
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Owner</th>
                <th scope="col">State</th>
                <th scope="col">Size</th>
                <th scope="col">Updated</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {props.page.data.map((attachment) => (
                <tr key={attachment.id}>
                  <td>
                    <strong>{attachment.filename}</strong>
                    <small>{attachment.mimeType}</small>
                  </td>
                  <td>
                    <code>{attachment.ownerId}</code>
                  </td>
                  <td>
                    <span className={`storage-state storage-state-${attachment.state}`}>
                      {attachment.state}
                    </span>
                    {attachment.inspectionError && (
                      <small className="storage-inspection-error">
                        {attachment.inspectionError}
                      </small>
                    )}
                  </td>
                  <td>{bytes(attachment.sizeBytes)}</td>
                  <td>
                    <time dateTime={attachment.updatedAt}>{timestamp(attachment.updatedAt)}</time>
                  </td>
                  <td>
                    {attachment.reinspectionEligible && (
                      <button
                        className="secondary ops-target"
                        disabled={props.reinspectionId === attachment.id}
                        onClick={() => openReinspection(attachment)}
                      >
                        {props.reinspectionId === attachment.id ? "Requesting…" : "Reinspect"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {props.page && (props.hasPrevious || props.page.nextCursor) && (
        <nav className="ops-pagination" aria-label="Attachment pages">
          <button
            className="secondary ops-target"
            disabled={!props.hasPrevious || props.inventoryLoading}
            onClick={props.onPrevious}
          >
            Previous
          </button>
          <button
            className="secondary ops-target"
            disabled={!props.page.nextCursor || props.inventoryLoading}
            onClick={() =>
              props.page?.nextCursor && props.onNext(props.page.nextCursor)}
          >
            Next
          </button>
        </nav>
      )}

      {selected && (
        <Modal
          title="Request attachment reinspection"
          close={closeReinspection}
          dismissible={props.reinspectionId !== selected.id}
        >
          <p>
            This does not release or approve the file. A worker will evaluate{" "}
            <strong>{selected.filename}</strong> using the current inspection policy.
          </p>
          {selected.state === "ready" && (
            <p role="note">
              This attachment will be temporarily unavailable to users until reinspection finishes
              successfully.
            </p>
          )}
          <label className="storage-reason">
            Reason
            <textarea
              data-autofocus
              value={reason}
              minLength={8}
              maxLength={500}
              rows={4}
              disabled={props.reinspectionId === selected.id}
              aria-describedby="storage-reinspection-hint"
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <small id="storage-reinspection-hint">
            Required for the audit record. Enter 8–500 characters.
          </small>
          {props.reinspectionError && (
            <p role="alert">
              {props.reinspectionConflict
                ? "This attachment changed. The inventory has been refreshed; review the latest state before trying again."
                : props.reinspectionError}
            </p>
          )}
          {props.reinspectionRecentAuth && props.onReauthenticate && (
            <button
              type="button"
              className="secondary ops-target"
              onClick={props.onReauthenticate}
            >
              Sign in again
            </button>
          )}
          <div className="modal-actions">
            <button
              className="secondary ops-target"
              disabled={props.reinspectionId === selected.id}
              onClick={closeReinspection}
            >
              Cancel
            </button>
            <button
              className="primary ops-target"
              disabled={reason.trim().length < 8 || props.reinspectionId === selected.id}
              onClick={async () => {
                try {
                  await props.onReinspect(selected, reason.trim());
                  setSelected(undefined);
                  setReason("");
                  requestAnimationFrame(() => actionRef.current?.focus());
                } catch {
                  // The dialog retains context and exposes the actionable mutation error.
                }
              }}
            >
              {props.reinspectionId === selected.id ? "Requesting…" : "Send to inspection"}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
