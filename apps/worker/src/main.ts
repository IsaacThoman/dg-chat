import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("DATABASE_URL");
const workerId = Deno.env.get("WORKER_ID") ?? `worker-${crypto.randomUUID().slice(0, 8)}`;
const pollMs = Number(Deno.env.get("WORKER_POLL_MS") ?? 1000);
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

async function claimJob() {
  return await sql.begin(async (tx) => {
    const rows = await tx<{ id: string; type: string; payload: unknown; attempts: number }[]>`
      SELECT id, type, payload, attempts FROM jobs
      WHERE status = 'queued' AND available_at <= now()
      ORDER BY available_at, created_at
      FOR UPDATE SKIP LOCKED LIMIT 1
    `;
    const job = rows[0];
    if (!job) return undefined;
    await tx`UPDATE jobs SET status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1 WHERE id = ${job.id}`;
    return job;
  });
}

function processJob(job: { id: string; type: string; payload: unknown; attempts: number }) {
  switch (job.type) {
    case "attachment.ingest":
      console.log(
        JSON.stringify({
          level: "info",
          message: "Attachment ingestion placeholder completed",
          jobId: job.id,
        }),
      );
      break;
    case "retention.scrub":
      console.log(
        JSON.stringify({ level: "info", message: "Retention scrub completed", jobId: job.id }),
      );
      break;
    default:
      throw new Error(`Unsupported job type: ${job.type}`);
  }
}

while (!stopping) {
  const job = await claimJob();
  if (!job) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    continue;
  }
  try {
    processJob(job);
    await sql`UPDATE jobs SET status = 'completed', completed_at = now(), locked_at = NULL, locked_by = NULL WHERE id = ${job.id}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retry = job.attempts + 1 < 5;
    await sql`UPDATE jobs SET status = ${
      retry ? "queued" : "failed"
    }, last_error = ${message}, available_at = now() + (${
      Math.min(300, 2 ** job.attempts)
    } * interval '1 second'), locked_at = NULL, locked_by = NULL WHERE id = ${job.id}`;
  }
}
await sql.end({ timeout: 5 });
console.log(JSON.stringify({ level: "info", message: "Worker stopped", workerId }));
