/**
 * A deliberately closed set of background failures that are safe to emit to an operational log.
 *
 * Do not add exception-derived values to these records. Provider URLs, SQL, object keys, and user
 * input can all occur in an exception message or stack. The detailed failure remains available to
 * the control-flow and durable domain records that already handle it; this process log is only a
 * stable, privacy-safe signal that an operator can count and alert on.
 */
const OPERATIONAL_FAILURES = {
  api_replay_maintenance: {
    component: "api",
    event: "api.replay_maintenance.failed",
    code: "background_task_failed",
    message: "Replay maintenance failed",
  },
  worker_temporary_conversation_purge: {
    component: "worker",
    event: "worker.temporary_conversation_purge.failed",
    code: "background_task_failed",
    message: "Temporary conversation purge failed",
  },
  worker_retention_scheduler: {
    component: "worker",
    event: "worker.retention_scheduler.failed",
    code: "background_task_failed",
    message: "Automatic retention scheduling failed",
  },
  database_repository_checkpoint: {
    component: "database",
    event: "database.repository_checkpoint.failed",
    code: "checkpoint_failed",
    message: "Repository checkpoint failed",
  },
} as const;

export type OperationalFailure = keyof typeof OPERATIONAL_FAILURES;
export type OperationalLogSink = (serializedRecord: string) => void;

/** Emit a fixed-schema failure signal without accepting arbitrary diagnostic data. */
export function logOperationalFailure(
  failure: OperationalFailure,
  sink: OperationalLogSink = console.error,
): void {
  const definition = OPERATIONAL_FAILURES[failure];
  sink(JSON.stringify({
    level: "error",
    severity: "error",
    ...definition,
  }));
}
