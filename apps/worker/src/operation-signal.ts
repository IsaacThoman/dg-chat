/**
 * Combines process shutdown with an absolute durable-job deadline.
 *
 * Callers must invoke `dispose` when the operation finishes so a long lease deadline does not keep
 * a timer alive. The first abort reason wins, preserving SIGTERM's AbortError or the caller's
 * domain-specific timeout error.
 */
export function operationSignal(
  parent: AbortSignal,
  deadlineAt: number,
  timeoutReason: () => unknown = () =>
    new DOMException("Operation deadline exceeded", "TimeoutError"),
): { signal: AbortSignal; dispose: () => void } {
  if (!Number.isFinite(deadlineAt)) throw new TypeError("Operation deadline must be finite");
  const deadline = new AbortController();
  const remaining = Math.max(0, deadlineAt - Date.now());
  const timer = setTimeout(() => deadline.abort(timeoutReason()), remaining);
  const signal = AbortSignal.any([parent, deadline.signal]);
  let disposed = false;
  return {
    signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
    },
  };
}

/** Rejects promptly when `signal` aborts while avoiding a dangling abort listener. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let removeListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    removeListener = () => signal.removeEventListener("abort", onAbort);
    // Close the check/listener race if shutdown landed between throwIfAborted and registration.
    if (signal.aborted) onAbort();
  });
  return Promise.race([promise, aborted]).finally(() => removeListener?.());
}
