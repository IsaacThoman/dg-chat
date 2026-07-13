export const DEFAULT_IDENTITY_DELIVERY_TIMEOUT_MS = 30_000;
export const IDENTITY_SHUTDOWN_ABORT_MS = 3_000;

export class IdentityDeliveryTimeoutError extends Error {
  constructor(message = "Identity delivery timed out") {
    super(message);
    this.name = "IdentityDeliveryTimeoutError";
  }
}

/**
 * Bound callbacks supplied by SMTP or authentication integrations. A timed-out callback may not
 * be cooperatively cancellable, but it no longer owns tracked shutdown state or prevents the
 * failure audit from being persisted. Production SMTP transports are also closed during shutdown.
 */
export function boundedIdentityDelivery(
  delivery: (signal: AbortSignal) => Promise<void>,
  controller: AbortController,
  timeoutMs: number,
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Identity delivery timeout must be a positive safe integer");
  }
  const signal = controller.signal;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      if (error === undefined) resolve();
      else reject(error);
    };
    const aborted = () => finish(signal.reason ?? new IdentityDeliveryTimeoutError());
    const timer = setTimeout(() => controller.abort(new IdentityDeliveryTimeoutError()), timeoutMs);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) {
      aborted();
      return;
    }
    Promise.resolve().then(() => delivery(signal)).then(() => finish(), finish);
  });
}

export async function drainIdentityDeliverySet(
  deliveries: Map<Promise<void>, AbortController>,
  abortAfterMs?: number,
): Promise<"settled" | "abandoned"> {
  if (abortAfterMs === undefined) {
    await Promise.allSettled([...deliveries.keys()]);
    return "settled";
  }
  if (!Number.isSafeInteger(abortAfterMs) || abortAfterMs < 0) {
    throw new Error("Identity delivery drain timeout must be a non-negative safe integer");
  }
  const snapshot = [...deliveries.keys()];
  const pending = Promise.allSettled(snapshot);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    pending.then(() => "settled" as const),
    new Promise<"abandoned">((resolve) => {
      timer = setTimeout(() => resolve("abandoned"), abortAfterMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (result === "settled") return result;
  for (const controller of deliveries.values()) {
    controller.abort(
      new IdentityDeliveryTimeoutError("Identity delivery abandoned at shutdown"),
    );
  }
  // Best-effort audit flush. A stalled audit store must not defeat the hard shutdown deadline.
  await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 100))]);
  // These operations are now explicitly abandoned. A later resource close must not re-wait on
  // the same stalled audit; its store is about to close under the outer shutdown deadline.
  for (const delivery of snapshot) deliveries.delete(delivery);
  return "abandoned";
}
