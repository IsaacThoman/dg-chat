export interface ApiShutdownOptions {
  cancelBackup(): Promise<unknown> | unknown;
  drainServer(): Promise<unknown> | unknown;
  forceServer(): Promise<unknown> | unknown;
  closeResources(): Promise<unknown> | unknown;
  drainGraceMs: number;
  forceGraceMs: number;
  resourceGraceMs: number;
}

type PhaseStatus = "settled" | "failed" | "timed_out";

export interface ApiShutdownOutcome {
  backupCancellation: PhaseStatus;
  httpDrain: PhaseStatus;
  forcedAbort: boolean;
  forceServer: PhaseStatus | "not_required";
  resources: PhaseStatus;
  failureCount: number;
  timeoutCount: number;
}

export function shutdownLogLevel(outcome: ApiShutdownOutcome): "info" | "warn" | "error" {
  if (outcome.failureCount > 0) return "error";
  if (outcome.timeoutCount > 0 || outcome.forcedAbort) return "warn";
  return "info";
}

const invoke = (work: () => Promise<unknown> | unknown) => {
  try {
    return Promise.resolve(work()).then(
      () => "settled" as const,
      () => "failed" as const,
    );
  } catch {
    return Promise.resolve("failed" as const);
  }
};
async function within(work: Promise<unknown>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), milliseconds);
  });
  try {
    return await Promise.race([work.then(() => "settled" as const), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Cancel backup work before beginning HTTP drain, then impose independent finite budgets on both
 * request draining and resource teardown. Calls are wrapped synchronously so an implementation
 * cannot defer cancellation until after a stalled request has completed.
 */
export async function shutdownApi(options: ApiShutdownOptions): Promise<ApiShutdownOutcome> {
  let backupStatus: ApiShutdownOutcome["backupCancellation"] = "timed_out";
  let drainStatus: ApiShutdownOutcome["httpDrain"] = "timed_out";
  const backup = invoke(options.cancelBackup).then((status) => backupStatus = status);
  const drain = invoke(options.drainServer).then((status) => drainStatus = status);
  await within(Promise.all([backup, drain]), options.drainGraceMs);
  const currentBackupStatus = backupStatus as ApiShutdownOutcome["backupCancellation"];
  const currentDrainStatus = drainStatus as ApiShutdownOutcome["httpDrain"];
  // Backup cancellation and HTTP drain share a deadline, but a stalled backup must not cause an
  // already-drained server to be force-aborted. Force only when the HTTP server itself did not
  // settle, and capture that action under its own finite budget.
  const forcedAbort = currentDrainStatus !== "settled";
  let forceStatus: ApiShutdownOutcome["forceServer"] = "not_required";
  if (forcedAbort) {
    let pendingForceStatus: PhaseStatus = "timed_out";
    const force = invoke(options.forceServer).then((status) => pendingForceStatus = status);
    await within(force, options.forceGraceMs);
    forceStatus = pendingForceStatus;
  }
  let resourceStatus: ApiShutdownOutcome["resources"] = "timed_out";
  const resources = invoke(options.closeResources).then((status) => resourceStatus = status);
  await within(resources, options.resourceGraceMs);
  const currentResourceStatus = resourceStatus as ApiShutdownOutcome["resources"];
  const phaseStatuses: PhaseStatus[] = [
    currentBackupStatus,
    currentDrainStatus,
    ...(forceStatus === "not_required" ? [] : [forceStatus]),
    currentResourceStatus,
  ];
  return {
    backupCancellation: currentBackupStatus,
    httpDrain: currentDrainStatus,
    forcedAbort,
    forceServer: forceStatus,
    resources: currentResourceStatus,
    failureCount: phaseStatuses.filter((status) => status === "failed").length,
    timeoutCount: phaseStatuses.filter((status) => status === "timed_out").length,
  };
}
