import {
  abortableDelay,
  boundedBackoffDelay,
  type BoundedBackoffPolicy,
} from "./resilient-loop.ts";
import { operationSignal, raceAbort } from "./operation-signal.ts";

const timedOut = () => new DOMException("Worker shutdown settlement timed out", "TimeoutError");

/**
 * Runs retryable finalization under one absolute deadline. A new database attempt is admitted only
 * when a complete statement-timeout window remains; near-deadline work is left to the durable
 * lease/reaper instead of starting a query that Compose may kill halfway through.
 */
export async function retryBeforeAbsoluteDeadline<T>(options: {
  operation: () => Promise<T>;
  deadlineAt: number;
  attemptWindowMs: number;
  policy: BoundedBackoffPolicy;
  shouldRetry: (error: unknown) => boolean;
  random?: () => number;
}): Promise<T> {
  if (!Number.isFinite(options.deadlineAt)) throw new TypeError("Deadline must be finite");
  if (!Number.isSafeInteger(options.attemptWindowMs) || options.attemptWindowMs < 1) {
    throw new TypeError("Attempt window must be a positive integer");
  }
  const deadline = operationSignal(new AbortController().signal, options.deadlineAt, timedOut);
  let failures = 0;
  try {
    while (true) {
      deadline.signal.throwIfAborted();
      if (options.deadlineAt - Date.now() < options.attemptWindowMs) throw timedOut();
      try {
        return await raceAbort(options.operation(), deadline.signal);
      } catch (error) {
        if (deadline.signal.aborted) throw deadline.signal.reason ?? error;
        if (!options.shouldRetry(error)) throw error;
        failures += 1;
        const delay = boundedBackoffDelay(failures, options.policy, options.random);
        if (options.deadlineAt - Date.now() < delay + options.attemptWindowMs) throw timedOut();
        await abortableDelay(delay, deadline.signal);
      }
    }
  } finally {
    deadline.dispose();
  }
}
