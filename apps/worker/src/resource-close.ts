import { operationSignal, raceAbort } from "./operation-signal.ts";

type Close = () => void | Promise<void>;

async function allClosures(closures: Close[]): Promise<void> {
  const results = await Promise.allSettled(closures.map((close) => Promise.resolve().then(close)));
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "Resource closure failed");
}

/**
 * Proves resource closure under one absolute budget. Graceful close gets only the prefix of the
 * budget; rejection or timeout switches to force-close while enough time remains to prove that
 * path. A caller must keep its process watchdog armed unless this function resolves.
 */
export async function closeResourcesBeforeDeadline(options: {
  graceful: Close[];
  forced: Close[];
  deadlineAt: number;
  forcedWindowMs: number;
}): Promise<"graceful" | "forced"> {
  if (!Number.isFinite(options.deadlineAt)) throw new TypeError("Close deadline must be finite");
  if (!Number.isSafeInteger(options.forcedWindowMs) || options.forcedWindowMs < 1) {
    throw new TypeError("Forced close window must be a positive integer");
  }
  const remaining = options.deadlineAt - Date.now();
  if (remaining <= 0) throw new DOMException("Resource close deadline elapsed", "TimeoutError");
  const gracefulDeadline = Math.max(Date.now(), options.deadlineAt - options.forcedWindowMs);
  const gracefulSignal = operationSignal(
    new AbortController().signal,
    gracefulDeadline,
    () => new DOMException("Graceful resource close timed out", "TimeoutError"),
  );
  try {
    await raceAbort(allClosures(options.graceful), gracefulSignal.signal);
    return "graceful";
  } catch {
    // Forced close is independently verified below; graceful rejection is never swallowed.
  } finally {
    gracefulSignal.dispose();
  }

  const forcedSignal = operationSignal(
    new AbortController().signal,
    options.deadlineAt,
    () => new DOMException("Forced resource close timed out", "TimeoutError"),
  );
  try {
    await raceAbort(allClosures(options.forced), forcedSignal.signal);
    return "forced";
  } finally {
    forcedSignal.dispose();
  }
}
