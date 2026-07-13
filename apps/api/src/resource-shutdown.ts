export interface IdentityAwareResourceShutdown {
  abortDeliveriesAfterMs: number;
  closeMailer?: () => Promise<unknown> | unknown;
  drainLegacyDeliveries: (abortAfterMs: number) => Promise<unknown>;
  drainBrowserDeliveries?: (abortAfterMs: number) => Promise<unknown>;
  closeResources: ReadonlyArray<() => Promise<unknown> | unknown>;
}

const invoke = async (operation: () => Promise<unknown> | unknown): Promise<void> => {
  try {
    await operation();
  } catch {
    // Shutdown is best-effort and must continue through every independent resource.
  }
};

/** Close the transport, persist delivery outcomes, then close stores that own those audits. */
export async function closeIdentityAwareResources(
  options: IdentityAwareResourceShutdown,
): Promise<void> {
  await Promise.all([
    invoke(() => options.drainLegacyDeliveries(options.abortDeliveriesAfterMs)),
    ...(options.drainBrowserDeliveries
      ? [invoke(() => options.drainBrowserDeliveries!(options.abortDeliveriesAfterMs))]
      : []),
  ]);
  if (options.closeMailer) await invoke(options.closeMailer);
  await Promise.all(options.closeResources.map(invoke));
}
