/**
 * Last-resort process boundary for drivers that ignore cancellation and forced pool close. The
 * exit code is zero because SIGTERM is an expected orchestrator action; durable assertions in
 * spawned tests separately prove the required settlement happened on the graceful path.
 */
export function armShutdownWatchdog(
  timeoutMs: number,
  forceClose: () => void,
  exit: (code: number) => never = Deno.exit,
): () => void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("Shutdown watchdog timeout must be a positive integer");
  }
  const timer = setTimeout(() => {
    try {
      forceClose();
    } catch {
      // Exit is the final boundary; a close failure cannot be allowed to skip it.
    }
    exit(0);
  }, timeoutMs);
  return () => clearTimeout(timer);
}
