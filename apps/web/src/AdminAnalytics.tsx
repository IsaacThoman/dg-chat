import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import type { AdminAnalyticsData, AdminAnalyticsStatus, AnalyticsBucket } from "./types.ts";

export interface AnalyticsFilters {
  from: string;
  to: string;
  bucket: AnalyticsBucket;
  status: "" | AdminAnalyticsStatus;
  userId: string;
  model: string;
  provider: string;
}

export interface AdminAnalyticsProps {
  data?: AdminAnalyticsData;
  filters: AnalyticsFilters;
  models?: string[];
  providers?: string[];
  loading?: boolean;
  error?: string;
  stale?: boolean;
  onApply(filters: AnalyticsFilters): void;
  onRetry(): void;
  onExport?(): void;
}

const money = (micros: number) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(
    micros / 1_000_000,
  );

export function boundedAnalyticsFilters(filters: AnalyticsFilters): AnalyticsFilters {
  return {
    from: filters.from.slice(0, 10),
    to: filters.to.slice(0, 10),
    bucket: filters.bucket === "hour" ? "hour" : "day",
    status: ["", "reserved", "completed", "failed"].includes(filters.status) ? filters.status : "",
    userId: filters.userId.slice(0, 36),
    model: filters.model.slice(0, 160),
    provider: filters.provider.slice(0, 160),
  };
}

export function AdminAnalytics(props: AdminAnalyticsProps) {
  const titleId = useId();
  const validationId = useId();
  const exportHintId = useId();
  const [draft, setDraft] = useState(props.filters);
  const [validationError, setValidationError] = useState<string>();
  const [invalidField, setInvalidField] = useState<"from" | "to" | "bucket">();
  const fromRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const bucketRef = useRef<HTMLSelectElement>(null);
  useEffect(() => setDraft(props.filters), [
    props.filters.from,
    props.filters.to,
    props.filters.bucket,
    props.filters.status,
    props.filters.userId,
    props.filters.model,
    props.filters.provider,
  ]);
  const dirty = Object.keys(draft).some((key) =>
    draft[key as keyof AnalyticsFilters] !== props.filters[key as keyof AnalyticsFilters]
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const from = Date.parse(`${draft.from}T00:00:00.000Z`);
    const to = Date.parse(`${draft.to}T00:00:00.000Z`);
    const days = (to - from) / 86_400_000 + 1;
    const result = from > to
      ? { message: "From must be on or before To.", field: "from" as const }
      : days > 90
      ? { message: "Usage analytics are limited to 90 days.", field: "to" as const }
      : draft.bucket === "hour" && days > 14
      ? { message: "Hourly analytics are limited to 14 days.", field: "bucket" as const }
      : undefined;
    const error = result?.message;
    setValidationError(error);
    setInvalidField(result?.field);
    if (result) {
      ({ from: fromRef, to: toRef, bucket: bucketRef })[result.field].current?.focus();
      return;
    }
    props.onApply(boundedAnalyticsFilters(draft));
  };
  const providerOptions = useMemo(
    () => [...new Set([draft.provider, ...(props.providers ?? [])].filter(Boolean))],
    [draft.provider, props.providers],
  );
  const modelOptions = useMemo(
    () => [...new Set([draft.model, ...(props.models ?? [])].filter(Boolean))],
    [draft.model, props.models],
  );
  const maxCalls = Math.max(1, ...(props.data?.points.map((point) => point.calls) ?? [1]));
  const points = props.data?.points ?? [];
  return (
    <section className="ops-page" aria-labelledby={titleId}>
      <div className="ops-heading">
        <div>
          <h1 id={titleId}>Usage analytics</h1>
          <p>Request volume, performance, tokens, and cost.</p>
        </div>
        {props.onExport && (
          <div className="ops-export-actions">
            <button
              className="secondary ops-target"
              disabled={dirty}
              aria-describedby={dirty ? exportHintId : undefined}
              onClick={props.onExport}
            >
              Export CSV
            </button>
            {dirty && <span id={exportHintId}>Apply filters to enable export.</span>}
          </div>
        )}
      </div>
      <form className="ops-filters" aria-label="Usage filters" onSubmit={submit}>
        <label>
          From<input
            ref={fromRef}
            name="from"
            type="date"
            value={draft.from}
            max={draft.to}
            aria-invalid={invalidField === "from" || undefined}
            aria-describedby={invalidField === "from" ? validationId : undefined}
            onChange={(event) => {
              setDraft({ ...draft, from: event.target.value });
              setValidationError(undefined);
              setInvalidField(undefined);
            }}
            required
          />
        </label>
        <label>
          To<input
            ref={toRef}
            name="to"
            type="date"
            value={draft.to}
            min={draft.from}
            aria-invalid={invalidField === "to" || undefined}
            aria-describedby={invalidField === "to" ? validationId : undefined}
            onChange={(event) => {
              setDraft({ ...draft, to: event.target.value });
              setValidationError(undefined);
              setInvalidField(undefined);
            }}
            required
          />
        </label>
        <label>
          Bucket<select
            ref={bucketRef}
            name="bucket"
            value={draft.bucket}
            aria-invalid={invalidField === "bucket" || undefined}
            aria-describedby={invalidField === "bucket" ? validationId : undefined}
            onChange={(event) => {
              setDraft({ ...draft, bucket: event.target.value as AnalyticsBucket });
              setValidationError(undefined);
              setInvalidField(undefined);
            }}
          >
            <option value="day">Daily</option>
            <option value="hour">Hourly</option>
          </select>
        </label>
        <label>
          Status<select
            name="status"
            value={draft.status}
            onChange={(event) =>
              setDraft({ ...draft, status: event.target.value as AnalyticsFilters["status"] })}
          >
            <option value="">All statuses</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="reserved">In progress</option>
          </select>
        </label>
        <label>
          Provider<select
            name="provider"
            value={draft.provider}
            onChange={(event) => setDraft({ ...draft, provider: event.target.value })}
          >
            <option value="">All providers</option>
            {providerOptions.map((value) => <option key={value}>{value}</option>)}
          </select>
        </label>
        <label>
          Model<select
            name="model"
            value={draft.model}
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
          >
            <option value="">All models</option>
            {modelOptions.map((value) => <option key={value}>{value}</option>)}
          </select>
        </label>
        <label>
          User ID<input
            name="userId"
            value={draft.userId}
            maxLength={36}
            onChange={(event) => setDraft({ ...draft, userId: event.target.value })}
          />
        </label>
        <button className="primary ops-target" type="submit">Apply filters</button>
      </form>
      {validationError && (
        <p id={validationId} className="ops-validation" role="alert">{validationError}</p>
      )}
      <div
        className="ops-announcer"
        role={props.error && !props.data ? "alert" : "status"}
        aria-live="polite"
      >
        {props.loading
          ? "Loading usage analytics…"
          : props.error
          ? props.data ? `Showing older data. ${props.error}` : props.error
          : props.stale
          ? "Showing cached data while the latest values load."
          : ""}
      </div>
      {props.error && !props.data && (
        <button className="secondary ops-target" onClick={props.onRetry}>
          Retry loading analytics
        </button>
      )}
      {props.data && (
        <>
          <div className="ops-metrics" aria-label="Usage summary">
            <Metric label="Calls" value={props.data.summary.calls.toLocaleString()} />
            <Metric label="Completed" value={props.data.summary.completed.toLocaleString()} />
            <Metric label="Failed" value={props.data.summary.failed.toLocaleString()} />
            <Metric label="Success rate" value={`${props.data.summary.successRate.toFixed(1)}%`} />
            <Metric label="Input tokens" value={props.data.summary.inputTokens.toLocaleString()} />
            <Metric
              label="Output tokens"
              value={props.data.summary.outputTokens.toLocaleString()}
            />
            <Metric
              label="Cached input"
              value={props.data.summary.cachedInputTokens.toLocaleString()}
            />
            <Metric
              label="Reasoning tokens"
              value={props.data.summary.reasoningTokens.toLocaleString()}
            />
            <Metric label="Customer cost" value={money(props.data.summary.customerCostMicros)} />
            <Metric label="Provider cost" value={money(props.data.summary.providerCostMicros)} />
            <Metric
              label="P95 latency"
              value={props.data.summary.p95LatencyMs === null
                ? "Unavailable"
                : `${props.data.summary.p95LatencyMs.toLocaleString()} ms`}
            />
            <Metric
              label="Average TTFT"
              value={props.data.summary.avgTtftMs === null
                ? "Unavailable"
                : `${props.data.summary.avgTtftMs.toLocaleString()} ms`}
            />
          </div>
          {points.length === 0
            ? <p className="ops-empty" role="status">No usage matches these filters.</p>
            : (
              <div className="ops-chart-layout">
                <figure className="ops-chart" aria-labelledby={`${titleId}-chart-title`}>
                  <figcaption id={`${titleId}-chart-title`}>Calls over time</figcaption>
                  <svg
                    viewBox="0 0 600 180"
                    role="img"
                    aria-label="Calls over time; exact values follow in the table"
                  >
                    {points.map((point, index) => {
                      const width = 560 / points.length;
                      const height = Math.max(2, point.calls / maxCalls * 140);
                      return (
                        <rect
                          key={`${point.start}-${index}`}
                          x={20 + index * width}
                          y={155 - height}
                          width={Math.max(2, width - 4)}
                          height={height}
                          rx="2"
                        >
                          <title>{`${point.start}: ${point.calls} calls`}</title>
                        </rect>
                      );
                    })}
                  </svg>
                </figure>
                <div
                  className="ops-table-scroll"
                  tabIndex={0}
                  aria-label="Scrollable usage details"
                >
                  <table className="ops-table">
                    <caption>Exact usage values</caption>
                    <thead>
                      <tr>
                        <th scope="col">Period</th>
                        <th scope="col">Calls</th>
                        <th scope="col">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {points.map((point, index) => (
                        <tr key={`${point.start}-${index}`}>
                          <th scope="row">
                            <time dateTime={point.start}>{point.start}</time>
                          </th>
                          <td>{point.calls.toLocaleString()}</td>
                          <td>{money(point.customerCostMicros)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
        </>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="ops-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
