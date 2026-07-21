import { useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api.ts";
import { AdminAnalytics, type AnalyticsFilters } from "./AdminAnalytics.tsx";
import { AdminJobs, type JobFilters } from "./AdminJobs.tsx";
import type { AdminSearch } from "./adminRouting.ts";
import type {
  AdminAnalyticsFilters,
  AdminAnalyticsStatus,
  AdminJobFilters,
  AdminJobStatus,
  AdminWorkerInstance,
  AdminWorkerScope,
} from "./types.ts";

interface OperationsProps {
  search: AdminSearch;
  onSearch(search: AdminSearch): void;
}

const dateOnly = (value: Date) => value.toISOString().slice(0, 10);
export function defaultAnalyticsRange(now = new Date()): { from: string; to: string } {
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - 29);
  return { from: dateOnly(from), to: dateOnly(now) };
}

function exclusiveEnd(date: string) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString();
}

function analyticsApiFilters(filters: AnalyticsFilters): AdminAnalyticsFilters {
  return {
    from: `${filters.from}T00:00:00.000Z`,
    to: exclusiveEnd(filters.to),
    bucket: filters.bucket,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.userId ? { userId: filters.userId } : {}),
    ...(filters.model ? { model: filters.model } : {}),
    ...(filters.provider ? { provider: filters.provider } : {}),
  };
}

const message = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : "The request failed.";

export function AdminAnalyticsView({ search, onSearch }: OperationsProps) {
  const defaults = useMemo(() => defaultAnalyticsRange(), []);
  const status = ["reserved", "completed", "failed"].includes(search.status ?? "")
    ? search.status as AdminAnalyticsStatus
    : "";
  const filters: AnalyticsFilters = {
    from: search.from ?? defaults.from,
    to: search.to ?? defaults.to,
    bucket: search.bucket ?? "day",
    status,
    userId: search.userId ?? "",
    model: search.model ?? "",
    provider: search.provider ?? "",
  };
  const apiFilters = analyticsApiFilters(filters);
  const query = useQuery({
    queryKey: ["admin-analytics", apiFilters],
    queryFn: () => api.adminAnalytics(apiFilters),
    placeholderData: (previous) => previous,
  });
  const apply = (next: AnalyticsFilters) =>
    onSearch({
      from: next.from,
      to: next.to,
      bucket: next.bucket,
      status: next.status || undefined,
      userId: next.userId || undefined,
      model: next.model || undefined,
      provider: next.provider || undefined,
    });
  return (
    <AdminAnalytics
      data={query.data}
      filters={filters}
      models={query.data?.models.map((item) => item.key)}
      providers={query.data?.providers.map((item) => item.key)}
      loading={query.isLoading}
      stale={query.isFetching && query.data !== undefined}
      error={query.error ? message(query.error) : undefined}
      onApply={apply}
      onRetry={() => void query.refetch()}
      onExport={() => location.assign(api.adminAnalyticsCsvUrl(apiFilters))}
    />
  );
}

export function AdminJobsView({ search, onSearch }: OperationsProps) {
  const queryClient = useQueryClient();
  const status = ["queued", "running", "completed", "failed"].includes(search.status ?? "")
    ? search.status as AdminJobStatus
    : "";
  const filters: JobFilters = { status, type: search.type ?? "" };
  const apiFilters: AdminJobFilters = {
    ...(status ? { status } : {}),
    ...(filters.type ? { type: filters.type } : {}),
  };
  const queryKey = ["admin-jobs", apiFilters, search.cursor ?? null] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => api.adminJobs(apiFilters, search.cursor),
    placeholderData: (previous) => previous,
  });
  const [workerScope, setWorkerScope] = useState<Exclude<AdminWorkerScope, "all">>("active");
  const workers = useInfiniteQuery({
    queryKey: ["admin-workers", workerScope],
    queryFn: ({ pageParam }) => api.adminWorkers(workerScope, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });
  const [actionOutcome, setActionOutcome] = useState<
    { kind: "success" | "error"; message: string } | undefined
  >();
  const retry = useMutation({
    mutationFn: api.retryAdminJob,
    onSuccess: async ({ job, priorAttempts }) => {
      setActionOutcome({
        kind: "success",
        message:
          `${job.type} was queued with a fresh retry budget after ${priorAttempts} attempts.`,
      });
      await queryClient.invalidateQueries({ queryKey: ["admin-jobs"] });
    },
    onError: (error, id) =>
      setActionOutcome({ kind: "error", message: `Could not retry job ${id}. ${message(error)}` }),
  });
  const apply = (next: JobFilters) => {
    setActionOutcome(undefined);
    onSearch({ status: next.status || undefined, type: next.type || undefined });
  };
  const changeCursor = (next?: string) => {
    onSearch({
      status: status || undefined,
      type: filters.type || undefined,
      cursor: next,
    });
  };
  return (
    <>
      <WorkerFleet
        workers={workers.data?.pages.flatMap((page) => page.items)}
        scope={workerScope}
        onScope={setWorkerScope}
        hasMore={workers.hasNextPage}
        loadingMore={workers.isFetchingNextPage}
        onLoadMore={() => void workers.fetchNextPage()}
        loading={workers.isLoading}
        error={workers.error ? message(workers.error) : undefined}
        onRetry={() => void workers.refetch()}
      />
      <AdminJobs
        page={query.data}
        filters={filters}
        loading={query.isLoading}
        stale={query.isFetching && query.data !== undefined}
        error={query.error ? message(query.error) : undefined}
        actionMessage={actionOutcome?.message}
        actionError={actionOutcome?.kind === "error"}
        retryingJobId={retry.isPending ? retry.variables : undefined}
        onApply={apply}
        onRetryLoad={() => void query.refetch()}
        onRetryJob={(id) => retry.mutateAsync(id).then(() => undefined)}
        onCursor={changeCursor}
      />
    </>
  );
}

function duration(ageMs: number) {
  if (ageMs < 1_000) return "now";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)}s ago`;
  return `${Math.floor(ageMs / 60_000)}m ago`;
}

export function WorkerFleet(props: {
  workers?: AdminWorkerInstance[];
  scope: Exclude<AdminWorkerScope, "all">;
  onScope(scope: Exclude<AdminWorkerScope, "all">): void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore(): void;
  loading: boolean;
  error?: string;
  onRetry(): void;
}) {
  return (
    <section className="ops-page" aria-labelledby="worker-fleet-title">
      <div className="ops-heading">
        <div>
          <h1 id="worker-fleet-title">Worker fleet</h1>
          <p>Boot-scoped heartbeat and durable progress for every background worker.</p>
        </div>
      </div>
      <div className="ops-filters" role="group" aria-label="Worker scope">
        {(["active", "history"] as const).map((scope) => (
          <button
            className={props.scope === scope ? "primary ops-target" : "secondary ops-target"}
            aria-pressed={props.scope === scope}
            onClick={() => props.onScope(scope)}
            key={scope}
          >
            {scope === "active" ? "Active boots" : "Stopped history"}
          </button>
        ))}
      </div>
      <div role={props.error && !props.workers ? "alert" : "status"} aria-live="polite">
        {props.loading
          ? "Loading worker health…"
          : props.error
          ? props.workers ? `Showing cached workers. ${props.error}` : props.error
          : props.workers?.length === 0
          ? "No worker boots have registered yet."
          : ""}
      </div>
      {props.error && !props.workers && (
        <button className="secondary ops-target" onClick={props.onRetry}>
          Retry worker health
        </button>
      )}
      {props.workers && props.workers.length > 0 && (
        <ul className="ops-job-list" aria-label="Worker instances">
          {props.workers.map((worker) => (
            <li className="ops-job-card" key={worker.instanceId}>
              <div className="ops-job-primary">
                <strong>{worker.workerName}</strong>
                <span>
                  <span
                    className={`ops-status ops-status-${worker.state}`}
                    aria-label={`Lifecycle: ${worker.state}`}
                  >
                    {worker.state}
                  </span>{" "}
                  <span
                    className={`ops-status ops-status-${worker.liveness}`}
                    aria-label={`Liveness: ${worker.liveness.replaceAll("_", " ")}`}
                  >
                    {worker.liveness.replaceAll("_", " ")}
                  </span>
                </span>
              </div>
              <dl>
                <div>
                  <dt>Boot</dt>
                  <dd>
                    <code>{worker.instanceId}</code>
                  </dd>
                </div>
                <div>
                  <dt>Heartbeat</dt>
                  <dd>{duration(worker.heartbeatAgeMs)}</dd>
                </div>
                <div>
                  <dt>Progress</dt>
                  <dd>{duration(worker.progressAgeMs)}</dd>
                </div>
                {worker.currentJobType && (
                  <div>
                    <dt>Current job</dt>
                    <dd>{worker.currentJobType}</dd>
                  </div>
                )}
                {worker.lastCompletedAt && (
                  <div>
                    <dt>Last completion</dt>
                    <dd>
                      {worker.lastCompletedJobType ?? "Job"}
                      {" · "}
                      <time dateTime={worker.lastCompletedAt}>
                        {new Date(worker.lastCompletedAt).toLocaleString()}
                      </time>
                    </dd>
                  </div>
                )}
              </dl>
            </li>
          ))}
        </ul>
      )}
      {props.hasMore && (
        <div className="ops-pagination">
          <button
            className="secondary ops-target"
            disabled={props.loadingMore}
            onClick={props.onLoadMore}
          >
            {props.loadingMore ? "Loading more…" : "Load more worker boots"}
          </button>
          <span role="status">More {props.scope} worker boots are available.</span>
        </div>
      )}
    </section>
  );
}
