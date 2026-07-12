import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api.ts";
import { AdminAnalytics, type AnalyticsFilters } from "./AdminAnalytics.tsx";
import { AdminJobs, type JobFilters } from "./AdminJobs.tsx";
import type { AdminSearch } from "./adminRouting.ts";
import type {
  AdminAnalyticsFilters,
  AdminAnalyticsStatus,
  AdminJobFilters,
  AdminJobStatus,
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
  );
}
