import { assertEquals, assertFalse } from "jsr:@std/assert@1.0.14";
import { logOperationalFailure, type OperationalFailure } from "./operational-logging.ts";

const HOSTILE_SECRET =
  "postgres://admin:raw-db-password@internal/db?sql=DELETE_FROM_users object/private-key";

const expected = {
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
} as const satisfies Record<OperationalFailure, Record<string, string>>;

for (const failure of Object.keys(expected) as OperationalFailure[]) {
  Deno.test(`privacy-safe operational sink: ${failure}`, () => {
    const hostile = new Error(`${HOSTILE_SECRET} user-input=<script>steal()</script>`);
    hostile.stack = `${HOSTILE_SECRET}\n at https://token@private.example/secret.ts:1:1`;
    const hostileObject = {
      message: hostile.message,
      stack: hostile.stack,
      url: `https://bearer:${HOSTILE_SECRET}@private.example`,
      sql: `SELECT '${HOSTILE_SECRET}'`,
      objectKey: `users/${HOSTILE_SECRET}`,
      toString: () => HOSTILE_SECRET,
    };

    // These values model the exception available at each audited catch site. The emitter has no
    // diagnostic-data argument, so neither an Error nor a hostile error-like object can reach it.
    void hostile;
    void hostileObject;
    const records: string[] = [];
    logOperationalFailure(failure, (record) => records.push(record));

    assertEquals(records.length, 1);
    assertFalse(records[0].includes(HOSTILE_SECRET));
    assertFalse(records[0].includes("<script>"));
    assertFalse(records[0].includes("private.example"));
    assertEquals(JSON.parse(records[0]), {
      level: "error",
      severity: "error",
      ...expected[failure],
    });
  });
}
