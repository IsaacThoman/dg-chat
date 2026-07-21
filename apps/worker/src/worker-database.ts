import { type BoundedBackoffPolicy, isWorkerRetryableDatabaseError } from "./resilient-loop.ts";
import { retryClaimedDatabaseOperation } from "./claimed-job-recovery.ts";

/** The one configured retry path for every worker-owned mutation under a durable claim. */
export function retryWorkerClaimedDatabaseOperation<T>(
  operation: () => T | PromiseLike<T>,
  renewClaim: () => Promise<boolean>,
  options: {
    signal: AbortSignal;
    policy: BoundedBackoffPolicy;
    onDatabaseRetry?: (notice: { attempt: number; delayMs: number }) => void;
  },
): Promise<T> {
  return retryClaimedDatabaseOperation(operation, renewClaim, {
    signal: options.signal,
    policy: options.policy,
    onDatabaseRetry: options.onDatabaseRetry,
    isRetryableDatabaseFault: isWorkerRetryableDatabaseError,
  });
}
