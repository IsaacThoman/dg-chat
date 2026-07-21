import {
  type BoundedBackoffPolicy,
  DatabaseOperationError,
  isJobLocalDatabaseError,
  isTransientDatabaseError,
  retryWithBoundedBackoff,
  runDatabaseOperation,
} from "./resilient-loop.ts";

type Sleep = (delayMs: number, signal: AbortSignal) => Promise<void>;

export interface ClaimSettlementOptions {
  signal: AbortSignal;
  policy: BoundedBackoffPolicy;
  sleep?: Sleep;
  random?: () => number;
  onDatabaseRetry?: (notice: { attempt: number; delayMs: number }) => void;
  isRetryableDatabaseFault?: (error: unknown) => boolean;
}

export class JobClaimReclaimedError extends Error {
  constructor() {
    super("Durable job claim was reclaimed");
    this.name = "JobClaimReclaimedError";
  }
}

/**
 * Retry one idempotent database mutation without replaying the surrounding external handler work.
 * Renewal happens before every attempt, including reconnect attempts, so an expired claimant and a
 * replacement replica race through the durable claim-token fence before any accounting mutation.
 */
export function retryClaimedDatabaseOperation<T>(
  operation: () => T | PromiseLike<T>,
  renewClaim: () => Promise<boolean>,
  options: ClaimSettlementOptions,
): Promise<T> {
  return retryWithBoundedBackoff({
    operation: async () => {
      const renewed = await runDatabaseOperation(renewClaim);
      if (!renewed) throw new JobClaimReclaimedError();
      return await runDatabaseOperation(operation);
    },
    signal: options.signal,
    policy: options.policy,
    shouldRetry: options.isRetryableDatabaseFault ?? isTransientDatabaseError,
    onRetry: options.onDatabaseRetry,
    sleep: options.sleep,
    random: options.random,
  });
}

/**
 * Retry only the database settlement, never the handler's external side effect. Every settlement
 * callback must fence its mutation with the current durable claim token and return false after a
 * different replica has reclaimed it.
 */
export function retryClaimSettlement(
  operation: () => Promise<boolean>,
  options: ClaimSettlementOptions,
): Promise<boolean> {
  return retryWithBoundedBackoff({
    operation: () => runDatabaseOperation(operation),
    signal: options.signal,
    policy: options.policy,
    shouldRetry: options.isRetryableDatabaseFault ?? isTransientDatabaseError,
    onRetry: options.onDatabaseRetry,
    sleep: options.sleep,
    random: options.random,
  });
}

export type ClaimedJobFaultDisposition =
  | "database_fault_deferred"
  | "application_failure_recorded"
  | "claim_reclaimed";

/**
 * Infrastructure faults from explicitly marked SQL operations are neutral: deferJob reverses the
 * claim's attempt increment. Unmarked S3/provider transport errors remain application failures.
 */
export async function settleClaimedJobFault(
  options: ClaimSettlementOptions & {
    fault: unknown;
    neutralDefer: () => Promise<boolean>;
    recordApplicationFailure: () => Promise<boolean>;
  },
): Promise<ClaimedJobFaultDisposition> {
  const databaseFault = (options.isRetryableDatabaseFault ?? isTransientDatabaseError)(
    options.fault,
  );
  // A data/integrity SQLSTATE is permanent for this job, not for the installation. Record it under
  // the ordinary application retry budget so one poison row cannot restart and reclaim-loop the
  // entire worker. Other proven non-transient database failures (auth, schema, protocol, resource
  // configuration) remain fatal operator faults and deliberately stop the worker.
  const jobLocalDatabaseFault = isJobLocalDatabaseError(options.fault);
  if (
    options.fault instanceof DatabaseOperationError && !databaseFault && !jobLocalDatabaseFault
  ) throw options.fault;
  const settled = await retryClaimSettlement(
    databaseFault ? options.neutralDefer : options.recordApplicationFailure,
    options,
  );
  if (!settled) return "claim_reclaimed";
  return databaseFault ? "database_fault_deferred" : "application_failure_recorded";
}
