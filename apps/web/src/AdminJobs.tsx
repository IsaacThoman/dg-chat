import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type { AdminJob, AdminJobPage, AdminJobStatus } from "./types.ts";
import { Modal } from "./Modal.tsx";

export interface JobFilters {
  status: "" | AdminJobStatus;
  type: string;
}
export interface AdminJobsProps {
  page?: AdminJobPage;
  filters: JobFilters;
  loading?: boolean;
  error?: string;
  stale?: boolean;
  actionMessage?: string;
  actionError?: boolean;
  retryingJobId?: string;
  onApply(filters: JobFilters): void;
  onRetryLoad(): void;
  onRetryJob(id: string): Promise<void> | void;
  onCursor(cursor?: string): void;
}

export function boundedJobFilters(filters: JobFilters): JobFilters {
  const statuses = ["", "queued", "running", "failed", "completed"];
  return {
    status: statuses.includes(filters.status) ? filters.status : "",
    type: filters.type.slice(0, 120),
  };
}

const displayStatus = (job: AdminJob) =>
  job.status === "queued" && Date.parse(job.availableAt) > Date.now() ? "scheduled" : job.status;

export function AdminJobs(props: AdminJobsProps) {
  const titleId = useId();
  const [confirming, setConfirming] = useState<AdminJob>();
  const [draft, setDraft] = useState(props.filters);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const restoreRetryFocus = useRef(true);
  useEffect(() => setDraft(props.filters), [props.filters.status, props.filters.type]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    props.onApply(boundedJobFilters(draft));
  };
  return (
    <section className="ops-page" aria-labelledby={titleId}>
      <div className="ops-heading">
        <div>
          <h1 id={titleId}>Background jobs</h1>
          <p>Monitor durable work and recover failed tasks.</p>
        </div>
      </div>
      <form className="ops-filters ops-job-filters" aria-label="Job filters" onSubmit={submit}>
        <label>
          Status<select
            name="status"
            value={draft.status}
            onChange={(event) =>
              setDraft({ ...draft, status: event.target.value as JobFilters["status"] })}
          >
            <option value="">All statuses</option>
            {["queued", "running", "failed", "completed"].map((status) => (
              <option key={status}>{status}</option>
            ))}
          </select>
        </label>
        <label>
          Type<input
            name="type"
            value={draft.type}
            maxLength={120}
            onChange={(event) => setDraft({ ...draft, type: event.target.value })}
          />
        </label>
        <button className="primary ops-target" type="submit">Apply filters</button>
      </form>
      <div
        ref={outcomeRef}
        className="ops-announcer"
        role={props.error && !props.page || props.actionError && !confirming ? "alert" : "status"}
        aria-live="polite"
        tabIndex={-1}
      >
        {props.loading
          ? "Loading background jobs…"
          : props.error
          ? props.page ? `Showing older jobs. ${props.error}` : props.error
          : props.stale
          ? "Showing cached jobs while refreshing."
          : confirming && props.actionError
          ? ""
          : props.actionMessage ?? ""}
      </div>
      {props.error && !props.page && (
        <button className="secondary ops-target" onClick={props.onRetryLoad}>
          Retry loading jobs
        </button>
      )}
      {props.page && props.page.items.length === 0 && (
        <p className="ops-empty" role="status">No jobs match these filters.</p>
      )}
      {props.page && props.page.items.length > 0 && (
        <ul className="ops-job-list" aria-label="Background jobs">
          {props.page.items.map((job) => (
            <li className="ops-job-card" key={job.id}>
              <div className="ops-job-primary">
                <strong>{job.type}</strong>
                <span className={`ops-status ops-status-${displayStatus(job)}`}>
                  {displayStatus(job)}
                </span>
              </div>
              <dl>
                <div>
                  <dt>Job</dt>
                  <dd>
                    <code>{job.id}</code>
                  </dd>
                </div>
                <div>
                  <dt>Attempts</dt>
                  <dd>{job.attempts}</dd>
                </div>
                <div>
                  <dt>Available</dt>
                  <dd>
                    <time dateTime={job.availableAt}>
                      {new Date(job.availableAt).toLocaleString()}
                    </time>
                  </dd>
                </div>
                {job.lockedAt && (
                  <div>
                    <dt>Started</dt>
                    <dd>
                      <time dateTime={job.lockedAt}>{new Date(job.lockedAt).toLocaleString()}</time>
                    </dd>
                  </div>
                )}
                {job.completedAt && (
                  <div>
                    <dt>Completed</dt>
                    <dd>
                      <time dateTime={job.completedAt}>
                        {new Date(job.completedAt).toLocaleString()}
                      </time>
                    </dd>
                  </div>
                )}
                {job.status === "failed" && job.lastError && (
                  <div className="ops-job-error">
                    <dt>Failure</dt>
                    <dd>{job.lastError}</dd>
                  </div>
                )}
              </dl>
              {job.status === "failed" && (
                <button
                  className="secondary ops-target"
                  disabled={props.retryingJobId === job.id}
                  onClick={() => {
                    restoreRetryFocus.current = true;
                    setConfirming(job);
                  }}
                >
                  {props.retryingJobId === job.id ? "Retrying…" : `Retry ${job.type}`}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {props.page && (props.page.hasPrevious || props.page.nextCursor) && (
        <nav className="ops-pagination" aria-label="Job pages">
          <button
            className="secondary ops-target"
            disabled={!props.page.hasPrevious || props.loading}
            onClick={() =>
              props.onCursor(props.page?.previousCursor ?? undefined)}
          >
            Previous
          </button>
          <button
            className="secondary ops-target"
            disabled={!props.page.nextCursor || props.loading}
            onClick={() =>
              props.page?.nextCursor && props.onCursor(props.page.nextCursor)}
          >
            Next
          </button>
        </nav>
      )}
      {confirming && (
        <Modal
          title="Retry failed job?"
          close={() => setConfirming(undefined)}
          dismissible={props.retryingJobId !== confirming.id}
          restoreFocus={() => restoreRetryFocus.current}
        >
          <p>
            This queues another attempt for{" "}
            {confirming.type}. It does not expose or modify the original payload.
          </p>
          {props.actionError && props.actionMessage && <p role="alert">{props.actionMessage}</p>}
          <div className="ops-dialog-actions">
            <button
              className="secondary ops-target"
              data-autofocus
              disabled={props.retryingJobId === confirming.id}
              onClick={() => setConfirming(undefined)}
            >
              Cancel
            </button>
            <button
              className="primary ops-target"
              disabled={props.retryingJobId === confirming.id}
              onClick={async () => {
                const id = confirming.id;
                try {
                  await props.onRetryJob(id);
                  restoreRetryFocus.current = false;
                  setConfirming(undefined);
                  requestAnimationFrame(() => outcomeRef.current?.focus());
                } catch {
                  // The parent exposes the actionable failure in this dialog and the page announcer.
                }
              }}
            >
              {props.retryingJobId === confirming.id ? "Retrying…" : "Retry job"}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
