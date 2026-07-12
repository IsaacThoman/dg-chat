export interface ApiShutdownOptions {
  cancelBackup(): Promise<unknown> | unknown;
  drainServer(): Promise<unknown> | unknown;
  forceServer(): Promise<unknown> | unknown;
  closeResources(): Promise<unknown> | unknown;
  drainGraceMs: number;
  resourceGraceMs: number;
}

const settled = (work: Promise<unknown> | unknown) => Promise.resolve(work).catch(() => undefined);
const invoke = (work: () => Promise<unknown> | unknown) => {
  try {
    return settled(work());
  } catch {
    return Promise.resolve();
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
export async function shutdownApi(options: ApiShutdownOptions): Promise<void> {
  const backup = invoke(options.cancelBackup);
  const drain = invoke(options.drainServer);
  const drainResult = await within(Promise.all([backup, drain]), options.drainGraceMs);
  if (drainResult === "timeout") void invoke(options.forceServer);
  await within(invoke(options.closeResources), options.resourceGraceMs);
}
