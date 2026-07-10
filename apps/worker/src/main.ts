import postgres from "npm:postgres@3.4.7";
import {
  assertAttachmentInspectionTerminal,
  AttachmentInspectionPendingError,
  parseAttachmentInspectionPayload,
} from "./attachment-inspection.ts";
import { claimJob, completeJob, deferJob, failOrRetryJob } from "./job-queue.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const workerId = Deno.env.get("WORKER_ID") ?? `worker-${crypto.randomUUID().slice(0, 8)}`;
const pollMs = Number(Deno.env.get("WORKER_POLL_MS") ?? 1000);
const jobLeaseSeconds = Number(Deno.env.get("WORKER_JOB_LEASE_SECONDS") ?? 120);
if (!Number.isSafeInteger(pollMs) || pollMs < 10) {
  throw new Error("WORKER_POLL_MS must be an integer of at least 10 milliseconds");
}
if (!Number.isSafeInteger(jobLeaseSeconds) || jobLeaseSeconds < 1) {
  throw new Error("WORKER_JOB_LEASE_SECONDS must be a positive integer");
}
let stopping = false;

const abort = () => {
  stopping = true;
};
Deno.addSignalListener("SIGINT", abort);
if (Deno.build.os !== "windows") Deno.addSignalListener("SIGTERM", abort);

if (!databaseUrl) {
  console.log(
    JSON.stringify({ level: "warn", message: "DATABASE_URL not set; worker is idle", workerId }),
  );
  while (!stopping) await new Promise((resolve) => setTimeout(resolve, pollMs));
  Deno.exit(0);
}

const sql = postgres(databaseUrl, { max: 4 });
console.log(JSON.stringify({ level: "info", message: "Worker started", workerId }));

async function processJob(
  job: { id: string; type: string; payload: unknown; attempts: number },
) {
  switch (job.type) {
    case "attachment.inspect": {
      const { attachmentId, ownerId } = parseAttachmentInspectionPayload(job.payload);
      const rows = await sql<{ state: string }[]>`
        SELECT state FROM attachments WHERE id=${attachmentId} AND owner_id=${ownerId}
      `;
      const state = rows[0]?.state;
      assertAttachmentInspectionTerminal(state);
      console.log(
        JSON.stringify({
          level: "info",
          message: "Attachment inspection result acknowledged",
          jobId: job.id,
          attachmentId,
          state,
        }),
      );
      break;
    }
    default:
      throw new Error(`Unsupported job type: ${job.type}`);
  }
}

while (!stopping) {
  const job = await claimJob(sql, workerId, jobLeaseSeconds);
  if (!job) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    continue;
  }
  try {
    await processJob(job);
    await completeJob(sql, job);
  } catch (error) {
    if (error instanceof AttachmentInspectionPendingError) {
      await deferJob(sql, job, 5);
      continue;
    }
    const message = error instanceof Error ? error.message : String(error);
    await failOrRetryJob(sql, job, message);
  }
}
await sql.end({ timeout: 5 });
console.log(JSON.stringify({ level: "info", message: "Worker stopped", workerId }));
