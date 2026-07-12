import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { api, ApiError } from "./api.ts";
import { Modal } from "./Modal.tsx";
import type { AdminSearch } from "./adminRouting.ts";
import type {
  RetentionDays,
  RetentionPolicy,
  RetentionPreview,
  RetentionScrubRun,
} from "./types.ts";

const choices: RetentionDays[] = [1, 7, 14, 30, 90];
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "The retention request failed.";
const bytes = (value: number) =>
  new Intl.NumberFormat(undefined, { style: "unit", unit: "byte", notation: "compact" }).format(
    value,
  );

interface Draft {
  captureEnabled: boolean;
  requestBodyDays: RetentionDays;
  responseBodyDays: RetentionDays;
}

export function AdminRetentionView(
  { search, onSearch }: { search: AdminSearch; onSearch(search: AdminSearch): void },
) {
  const client = useQueryClient();
  const scrubKey = useRef(crypto.randomUUID());
  const policy = useQuery({
    queryKey: ["admin-retention-policy"],
    queryFn: api.adminRetentionPolicy,
  });
  const runs = useQuery({
    queryKey: ["admin-retention-runs"],
    queryFn: () => api.adminRetentionScrubRuns(),
  });
  const selectedRun = useQuery({
    queryKey: ["admin-retention-run", search.run],
    queryFn: () => api.adminRetentionScrubRun(search.run!),
    enabled: Boolean(search.run),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 2_000 : false;
    },
  });
  const save = useMutation({
    mutationFn: api.updateAdminRetentionPolicy,
    onSuccess: (next) => {
      client.setQueryData(["admin-retention-policy"], next);
      client.removeQueries({ queryKey: ["admin-retention-preview"] });
    },
  });
  const preview = useMutation({
    mutationFn: api.previewAdminRetention,
    onSuccess: () => {
      scrubKey.current = crypto.randomUUID();
    },
  });
  useEffect(() => {
    if (preview.data && policy.data && preview.data.policyVersion !== policy.data.version) {
      preview.reset();
    }
  }, [policy.data?.version, preview.data?.policyVersion]);
  const scrub = useMutation({
    mutationFn: ({ idempotencyKey, candidate }: {
      idempotencyKey: string;
      candidate: RetentionPreview;
    }) => api.createAdminRetentionScrub(idempotencyKey, candidate),
    onSuccess: async (run) => {
      preview.reset();
      scrubKey.current = crypto.randomUUID();
      client.setQueryData(["admin-retention-run", run.id], run);
      await client.invalidateQueries({ queryKey: ["admin-retention-runs"] });
      onSearch({ run: run.id });
    },
  });
  useEffect(() => {
    const run = selectedRun.data;
    if (!run) return;
    client.setQueryData<{ items: RetentionScrubRun[] }>(
      ["admin-retention-runs"],
      (current) =>
        current ? { items: current.items.map((item) => item.id === run.id ? run : item) } : current,
    );
    if (run.status === "completed" || run.status === "failed") {
      void client.invalidateQueries({ queryKey: ["admin-retention-runs"] });
    }
  }, [client, selectedRun.data?.id, selectedRun.data?.status]);
  return (
    <AdminRetention
      policy={policy.data}
      policyLoading={policy.isLoading}
      policyStale={policy.isError && policy.data !== undefined}
      policyError={policy.isError ? errorMessage(policy.error) : undefined}
      preview={preview.data}
      previewPending={preview.isPending}
      previewError={preview.isError ? errorMessage(preview.error) : undefined}
      selectedRun={selectedRun.data}
      runLoading={selectedRun.isLoading}
      runStale={selectedRun.isError && selectedRun.data !== undefined}
      runError={selectedRun.isError ? errorMessage(selectedRun.error) : undefined}
      recentRuns={runs.data?.items ?? []}
      recentRunsLoading={runs.isLoading}
      recentRunsError={runs.isError ? errorMessage(runs.error) : undefined}
      savePending={save.isPending}
      saveError={save.isError ? errorMessage(save.error) : undefined}
      saveConflict={save.error instanceof ApiError && save.error.status === 409}
      scrubPending={scrub.isPending}
      scrubError={scrub.isError ? errorMessage(scrub.error) : undefined}
      scrubConflict={scrub.error instanceof ApiError && scrub.error.status === 409}
      onRetryPolicy={() => void policy.refetch()}
      onReloadPolicy={async () => {
        save.reset();
        preview.reset();
        await client.invalidateQueries({ queryKey: ["admin-retention-policy"] });
      }}
      onSave={(draft) => save.mutateAsync({ ...draft, expectedVersion: policy.data!.version })}
      onPreview={() => preview.mutateAsync(policy.data!.version).then(() => undefined)}
      onRefreshPreview={async () => {
        scrub.reset();
        preview.reset();
        await preview.mutateAsync(policy.data!.version);
      }}
      onScrub={(candidate) =>
        scrub.mutateAsync({ idempotencyKey: scrubKey.current, candidate })
          .then(
            () => undefined,
          )}
      onSelectRun={(id) => onSearch({ run: id })}
      onRetryRun={() => void selectedRun.refetch()}
      onRetryRuns={() => void runs.refetch()}
    />
  );
}

export interface AdminRetentionProps {
  policy?: RetentionPolicy;
  policyLoading?: boolean;
  policyStale?: boolean;
  policyError?: string;
  preview?: RetentionPreview;
  previewPending?: boolean;
  previewError?: string;
  selectedRun?: RetentionScrubRun;
  runLoading?: boolean;
  runStale?: boolean;
  runError?: string;
  recentRuns: RetentionScrubRun[];
  recentRunsLoading?: boolean;
  recentRunsError?: string;
  savePending?: boolean;
  saveError?: string;
  saveConflict?: boolean;
  scrubPending?: boolean;
  scrubError?: string;
  scrubConflict?: boolean;
  onRetryPolicy(): void;
  onReloadPolicy(): Promise<void>;
  onSave(draft: Draft): Promise<unknown>;
  onPreview(): Promise<void>;
  onRefreshPreview(): Promise<void>;
  onScrub(preview: RetentionPreview): Promise<void>;
  onSelectRun(id: string): void;
  onRetryRun(): void;
  onRetryRuns(): void;
}

export function AdminRetention(props: AdminRetentionProps) {
  const titleId = useId();
  const runHeadingRef = useRef<HTMLHeadingElement>(null);
  const [draft, setDraft] = useState<Draft | undefined>(() =>
    props.policy
      ? {
        captureEnabled: props.policy.captureEnabled,
        requestBodyDays: props.policy.requestBodyDays,
        responseBodyDays: props.policy.responseBodyDays,
      }
      : undefined
  );
  const [review, setReview] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [externalPolicyChange, setExternalPolicyChange] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const lastPolicy = useRef<RetentionPolicy | undefined>(props.policy);
  useEffect(() => {
    if (!props.policy) return;
    const incoming = props.policy;
    const previous = lastPolicy.current;
    const incomingDraft = policyDraft(incoming);
    if (!previous || !draft) {
      setDraft(incomingDraft);
      setExternalPolicyChange(false);
    } else if (incoming.version !== previous.version) {
      const wasDirty = !sameDraft(draft, policyDraft(previous));
      if (wasDirty && !sameDraft(draft, incomingDraft)) setExternalPolicyChange(true);
      else {
        setDraft(incomingDraft);
        setExternalPolicyChange(false);
      }
    }
    lastPolicy.current = incoming;
  }, [
    props.policy?.version,
    props.policy?.captureEnabled,
    props.policy?.requestBodyDays,
    props.policy?.responseBodyDays,
  ]);
  useEffect(() => {
    if (props.selectedRun) runHeadingRef.current?.focus();
  }, [props.selectedRun?.id]);
  const changed = Boolean(
    props.policy && draft && (
      props.policy.captureEnabled !== draft.captureEnabled ||
      props.policy.requestBodyDays !== draft.requestBodyDays ||
      props.policy.responseBodyDays !== draft.responseBodyDays
    ),
  );
  const previewBlocked = changed || props.policyStale || externalPolicyChange;
  const previewCount = props.preview
    ? props.preview.requestBodies + props.preview.responseBodies
    : 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (changed) setReview(true);
  };
  return (
    <section className="retention-page" aria-labelledby={titleId}>
      <p className="ops-announcer" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <header className="ops-heading">
        <div>
          <h1 id={titleId}>Retention</h1>
          <p>Control optional diagnostic payload storage and scrubbing.</p>
        </div>
        <button
          className="secondary ops-target"
          disabled={props.policyLoading || props.savePending || props.scrubPending}
          onClick={() => void props.onReloadPolicy()}
        >
          {props.policyLoading ? "Refreshing…" : "Refresh policy"}
        </button>
      </header>
      <div className="retention-invariant">
        <ShieldCheck aria-hidden="true" />
        <div>
          <strong>Accounting history is always preserved</strong>
          <p>
            Scrubbing removes eligible diagnostic request and response bodies only. It does not
            delete chats, attachments, audit events, usage totals, costs, or provider credentials.
          </p>
        </div>
      </div>
      {props.policyLoading && <p role="status">Loading retention policy…</p>}
      {props.policyError && !props.policy && (
        <div role="alert" className="ops-empty">
          <p>{props.policyError}</p>
          <button className="secondary ops-target" onClick={props.onRetryPolicy}>
            Retry loading policy
          </button>
        </div>
      )}
      {props.policyStale && (
        <p className="ops-announcer" role="status">
          Showing the last policy. Refresh failed; changes and previews are disabled.
        </p>
      )}
      {externalPolicyChange && props.policy && draft && (
        <div className="retention-external-change" role="alert">
          <div>
            <strong>The policy changed in another session</strong>
            <p>Your unsaved edits are preserved. Choose how to continue with the latest policy.</p>
          </div>
          <div>
            <button
              className="secondary ops-target"
              onClick={() => {
                setDraft(policyDraft(props.policy!));
                setExternalPolicyChange(false);
              }}
            >
              Use latest policy
            </button>
            <button
              className="primary ops-target"
              onClick={() =>
                setExternalPolicyChange(false)}
            >
              Review my edits against latest
            </button>
          </div>
        </div>
      )}
      {props.policy && draft && (
        <form
          className="retention-policy"
          aria-label="Retention policy"
          onSubmit={submit}
          aria-busy={props.savePending}
        >
          <div className="retention-policy-head">
            <div>
              <h2>Diagnostic payload policy</h2>
              <p>
                Last updated{" "}
                <time dateTime={props.policy.updatedAt}>
                  {new Date(props.policy.updatedAt).toLocaleString()}
                </time>
                {props.policy.updatedBy ? ` by ${props.policy.updatedBy}` : ""}
              </p>
            </div>
            <span
              className={`ops-status ${props.policy.captureEnabled ? "ops-status-running" : ""}`}
            >
              Saved: capture {props.policy.captureEnabled ? "enabled" : "disabled"}
            </span>
          </div>
          <label className="retention-toggle">
            <input
              type="checkbox"
              checked={draft.captureEnabled}
              onChange={(event) => setDraft({ ...draft, captureEnabled: event.target.checked })}
            />
            <span>
              <strong>Capture new diagnostic payload bodies</strong>
              <small>
                Keep disabled unless request and response bodies are required for debugging.
              </small>
            </span>
          </label>
          <div className="retention-fields">
            <RetentionSelect
              label="Request body retention"
              value={draft.requestBodyDays}
              onChange={(requestBodyDays) => setDraft({ ...draft, requestBodyDays })}
            />
            <RetentionSelect
              label="Response body retention"
              value={draft.responseBodyDays}
              onChange={(responseBodyDays) => setDraft({ ...draft, responseBodyDays })}
            />
          </div>
          <button
            className="primary ops-target"
            disabled={!changed || props.policyStale || externalPolicyChange}
            type="submit"
          >
            Review policy change
          </button>
        </form>
      )}
      {props.policy && (
        <section className="retention-card" aria-labelledby="preview-heading">
          <div className="retention-card-head">
            <div>
              <h2 id="preview-heading">Scrub preview</h2>
              <p>Calculate eligible bodies before permanently removing anything.</p>
            </div>
            <button
              className="secondary ops-target"
              disabled={props.previewPending || previewBlocked}
              onClick={async () => {
                try {
                  await props.onPreview();
                  setAnnouncement("Scrub preview calculated.");
                } catch { /* rendered below */ }
              }}
            >
              {props.previewPending ? "Calculating…" : "Preview scrub"}
            </button>
          </div>
          {props.previewError && <p role="alert">{props.previewError}</p>}
          {props.preview && <PreviewDetails preview={props.preview} />}
          {props.preview && previewBlocked && (
            <p className="retention-preview-stale" role="status">
              This preview belongs to the previously saved policy and cannot be queued. Resolve
              policy changes, then calculate a fresh preview.
            </p>
          )}
          {props.preview && previewCount === 0 && (
            <p className="ops-empty" role="status">Nothing is currently eligible for scrubbing.</p>
          )}
          {props.preview && previewCount > 0 && (
            <button
              className="danger-button ops-target"
              disabled={previewBlocked}
              onClick={() => {
                setAcknowledged(false);
                setConfirm(true);
              }}
            >
              Run scrub now
            </button>
          )}
        </section>
      )}
      {(props.selectedRun || props.runError || props.runLoading) && (
        <section className="retention-card" aria-labelledby="run-heading">
          <h2 ref={runHeadingRef} id="run-heading" tabIndex={-1}>Scrub run status</h2>
          {props.runLoading && <p role="status">Loading scrub run…</p>}
          {props.runStale && <p role="status">Showing the last run status. Refresh failed.</p>}
          {props.runError && !props.selectedRun && <p role="alert">{props.runError}</p>}
          {props.runError && !props.selectedRun && (
            <button className="secondary ops-target" onClick={props.onRetryRun}>Retry run</button>
          )}
          {props.selectedRun && <RunDetails run={props.selectedRun} />}
        </section>
      )}
      <section className="retention-card" aria-labelledby="recent-runs-heading">
        <h2 id="recent-runs-heading">Recent scrub runs</h2>
        {props.recentRunsLoading && <p role="status">Loading recent scrub runs…</p>}
        {props.recentRunsError && <p role="alert">{props.recentRunsError}</p>}
        {props.recentRunsError && (
          <button className="secondary ops-target" onClick={props.onRetryRuns}>
            Retry recent runs
          </button>
        )}
        {!props.recentRunsLoading && !props.recentRunsError && props.recentRuns.length === 0
          ? <p className="ops-empty">No scrub runs yet.</p>
          : !props.recentRunsLoading && !props.recentRunsError && (
            <ul className="retention-runs">
              {props.recentRuns.map((run) => (
                <li key={run.id}>
                  <button onClick={() => props.onSelectRun(run.id)}>
                    <span>
                      <strong>{run.status}</strong>
                      <small>
                        <time dateTime={run.createdAt}>
                          {new Date(run.createdAt).toLocaleString()}
                        </time>
                      </small>
                    </span>
                    <span>
                      {(run.requestBodiesScrubbed + run.responseBodiesScrubbed).toLocaleString()}
                      {" "}
                      bodies
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
      </section>
      {review && draft && props.policy && (
        <Modal
          title="Review retention policy"
          close={() => !props.savePending && setReview(false)}
          dismissible={!props.savePending}
        >
          <table className="retention-review">
            <caption>Current and proposed settings</caption>
            <thead>
              <tr>
                <th>Setting</th>
                <th>Current</th>
                <th>Proposed</th>
              </tr>
            </thead>
            <tbody>
              <ReviewRow
                label="Capture payload bodies"
                current={props.policy.captureEnabled ? "Enabled" : "Disabled"}
                proposed={draft.captureEnabled ? "Enabled" : "Disabled"}
              />
              <ReviewRow
                label="Request bodies"
                current={`${props.policy.requestBodyDays} days`}
                proposed={`${draft.requestBodyDays} days`}
              />
              <ReviewRow
                label="Response bodies"
                current={`${props.policy.responseBodyDays} days`}
                proposed={`${draft.responseBodyDays} days`}
              />
            </tbody>
          </table>
          {props.saveError && (
            <p role="alert">
              {props.saveConflict
                ? "The policy changed in another session. Reload the latest policy before saving."
                : props.saveError}
            </p>
          )}
          <div className="ops-dialog-actions">
            {props.saveConflict && (
              <button
                className="secondary ops-target"
                disabled={props.savePending}
                onClick={async () => {
                  await props.onReloadPolicy();
                  setReview(false);
                }}
              >
                Reload latest policy
              </button>
            )}
            <button
              className="secondary ops-target"
              data-autofocus
              disabled={props.savePending}
              onClick={() => setReview(false)}
            >
              Cancel
            </button>
            <button
              className="primary ops-target"
              disabled={props.savePending || props.saveConflict}
              onClick={async () => {
                try {
                  await props.onSave(draft);
                  setAnnouncement("Retention policy saved.");
                  setReview(false);
                } catch { /* rendered above */ }
              }}
            >
              {props.savePending ? "Saving…" : "Save policy"}
            </button>
          </div>
        </Modal>
      )}
      {confirm && props.preview && (
        <Modal
          title="Permanently scrub diagnostic bodies?"
          close={() => !props.scrubPending && setConfirm(false)}
          dismissible={!props.scrubPending}
        >
          <div aria-busy={props.scrubPending || undefined}>
            <div className="retention-warning">
              <AlertTriangle aria-hidden="true" />
              <p>
                This cannot be undone through the application. The preview includes{" "}
                {previewCount.toLocaleString()} eligible bodies.
              </p>
            </div>
            <PreviewDetails preview={props.preview} compact />
            <label className="retention-toggle">
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={props.scrubPending}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>
                <strong>
                  I understand eligible diagnostic payload bodies will be permanently removed.
                </strong>
              </span>
            </label>
            {props.scrubError && <p role="alert">{props.scrubError}</p>}
            <div className="ops-dialog-actions">
              {props.scrubConflict && (
                <button
                  className="secondary ops-target"
                  disabled={props.scrubPending}
                  onClick={async () => {
                    try {
                      await props.onRefreshPreview();
                      setConfirm(false);
                      setAcknowledged(false);
                      setAnnouncement(
                        "The stale preview was replaced with current retention data.",
                      );
                    } catch { /* rendered by the page */ }
                  }}
                >
                  Refresh preview
                </button>
              )}
              <button
                className="secondary ops-target"
                data-autofocus
                disabled={props.scrubPending}
                onClick={() => setConfirm(false)}
              >
                Cancel
              </button>
              <button
                className="danger-button ops-target"
                disabled={!acknowledged || props.scrubPending}
                onClick={async () => {
                  try {
                    await props.onScrub(props.preview!);
                    setAnnouncement("Retention scrub queued.");
                    setConfirm(false);
                  } catch { /* rendered above */ }
                }}
              >
                {props.scrubPending ? "Queueing scrub…" : "Queue scrub"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

function RetentionSelect(
  { label, value, onChange }: {
    label: string;
    value: RetentionDays;
    onChange(value: RetentionDays): void;
  },
) {
  return (
    <label>
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(Number(event.target.value) as RetentionDays)}
      >
        {choices.map((day) => <option key={day} value={day}>{day} days</option>)}
      </select>
      <small>
        Bodies older than this become eligible for scrubbing, even while new capture is disabled.
      </small>
    </label>
  );
}
function ReviewRow(
  { label, current, proposed }: { label: string; current: string; proposed: string },
) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{current}</td>
      <td>{proposed}</td>
    </tr>
  );
}
function PreviewDetails(
  { preview, compact = false }: { preview: RetentionPreview; compact?: boolean },
) {
  return (
    <dl className={`retention-summary ${compact ? "compact" : ""}`}>
      <div>
        <dt>Request cutoff</dt>
        <dd>
          <time dateTime={preview.requestCutoffAt}>
            {new Date(preview.requestCutoffAt).toLocaleString()}
          </time>
        </dd>
      </div>
      <div>
        <dt>Response cutoff</dt>
        <dd>
          <time dateTime={preview.responseCutoffAt}>
            {new Date(preview.responseCutoffAt).toLocaleString()}
          </time>
        </dd>
      </div>
      <div>
        <dt>Captures</dt>
        <dd>{preview.captures.toLocaleString()}</dd>
      </div>
      <div>
        <dt>Request bodies</dt>
        <dd>
          {preview.requestBodies.toLocaleString()} · {bytes(preview.requestBytes)}
        </dd>
      </div>
      <div>
        <dt>Response bodies</dt>
        <dd>
          {preview.responseBodies.toLocaleString()} · {bytes(preview.responseBytes)}
        </dd>
      </div>
    </dl>
  );
}

function policyDraft(policy: RetentionPolicy): Draft {
  return {
    captureEnabled: policy.captureEnabled,
    requestBodyDays: policy.requestBodyDays,
    responseBodyDays: policy.responseBodyDays,
  };
}

function sameDraft(left: Draft, right: Draft): boolean {
  return left.captureEnabled === right.captureEnabled &&
    left.requestBodyDays === right.requestBodyDays &&
    left.responseBodyDays === right.responseBodyDays;
}
function RunDetails({ run }: { run: RetentionScrubRun }) {
  return (
    <div>
      <p>
        <span
          className={`ops-status ops-status-${run.status}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          Scrub status: {run.status}
        </span>
      </p>
      {run.error && <p role="alert">{run.error}</p>}
      <dl className="retention-summary">
        <div>
          <dt>Request cutoff</dt>
          <dd>
            <time dateTime={run.requestCutoffAt}>
              {new Date(run.requestCutoffAt).toLocaleString()}
            </time>
          </dd>
        </div>
        <div>
          <dt>Response cutoff</dt>
          <dd>
            <time dateTime={run.responseCutoffAt}>
              {new Date(run.responseCutoffAt).toLocaleString()}
            </time>
          </dd>
        </div>
        <div>
          <dt>Captures scrubbed</dt>
          <dd>{run.capturesScrubbed.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Request bodies scrubbed</dt>
          <dd>{run.requestBodiesScrubbed.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Response bodies scrubbed</dt>
          <dd>{run.responseBodiesScrubbed.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Bytes scrubbed</dt>
          <dd>{bytes(run.bytesScrubbed)}</dd>
        </div>
      </dl>
    </div>
  );
}
