import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

async function eventually(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for generated object cleanup");
}

Deno.test({
  name: "worker durably cleans stale generated objects and fences durable references",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const suffix = crypto.randomUUID().slice(0, 8);
    const ownerId = crypto.randomUUID();
    const providerId = crypto.randomUUID();
    const modelId = crypto.randomUUID();
    const priceId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const concurrentMessageId = crypto.randomUUID();
    const cleanupAttachmentId = crypto.randomUUID();
    const messageAttachmentId = crypto.randomUUID();
    const generatedAttachmentId = crypto.randomUUID();
    const cleanupStageId = crypto.randomUUID();
    const messageStageId = crypto.randomUUID();
    const generatedStageId = crypto.randomUUID();
    const generatedAssetId = crypto.randomUUID();
    const generatedJobId = crypto.randomUUID();
    const runIds = {
      cleanup: `cleanup-run-${suffix}`,
      message: `message-run-${suffix}`,
      generated: `generated-run-${suffix}`,
    };
    const objectKeys = {
      cleanup: `generated/${ownerId}/cleanup-${suffix}.png`,
      message: `generated/${ownerId}/message-${suffix}.png`,
      generated: `generated/${ownerId}/asset-${suffix}.png`,
    };
    const deletes: string[] = [];
    let signalDeleteStarted!: () => void;
    let releaseDelete!: () => void;
    const deleteStarted = new Promise<void>((resolve) => signalDeleteStarted = resolve);
    const deleteRelease = new Promise<void>((resolve) => releaseDelete = resolve);
    const s3 = Deno.serve({ hostname: "127.0.0.1", port: 0 }, async (request) => {
      if (request.method === "DELETE") {
        deletes.push(decodeURIComponent(new URL(request.url).pathname));
        if (decodeURIComponent(new URL(request.url).pathname).endsWith(objectKeys.cleanup)) {
          signalDeleteStarted();
          await deleteRelease;
        }
      }
      return new Response(null, { status: request.method === "DELETE" ? 204 : 200 });
    });
    const port = (s3.addr as Deno.NetAddr).port;
    const worker = new Deno.Command(Deno.execPath(), {
      cwd: new URL("../../..", import.meta.url),
      args: ["run", "--allow-all", "apps/worker/src/main.ts"],
      env: {
        ...Deno.env.toObject(),
        DATABASE_URL: databaseUrl!,
        DENO_ENV: "test",
        WORKER_ID: `cleanup-test-${suffix}`,
        WORKER_POLL_MS: "10",
        WORKER_JOB_LEASE_SECONDS: "10",
        WORKER_JOB_DEADLINE_MARGIN_MS: "1000",
        GENERATED_OBJECT_CLEANUP_GRACE_SECONDS: "1",
        GENERATED_OBJECT_CLEANUP_SWEEP_MS: "1000",
        S3_BUCKET: "cleanup-test",
        S3_ENDPOINT: `http://127.0.0.1:${port}`,
        S3_REGION: "us-east-1",
        S3_ACCESS_KEY: "cleanup-test-access",
        S3_SECRET_KEY: "cleanup-test-secret",
        S3_FORCE_PATH_STYLE: "true",
      },
      stdout: "null",
      stderr: "piped",
    }).spawn();
    try {
      await sql`INSERT INTO users(id,email,name,password_hash,role,approval_status)
        VALUES(${ownerId},${`cleanup-${suffix}@worker.test`},'Cleanup owner','hash','admin','approved')`;
      await sql`INSERT INTO providers(id,slug,display_name,base_url,protocol)
        VALUES(${providerId},${`cleanup-${suffix}`},'Cleanup provider','https://cleanup.test/v1','responses')`;
      await sql`INSERT INTO provider_models(id,provider_id,public_model_id,upstream_model_id,
        display_name,capabilities,context_window) VALUES(${modelId},${providerId},
        ${`cleanup-${suffix}/image`},'image','Cleanup image','["image_generation"]'::jsonb,1)`;
      await sql`INSERT INTO model_price_versions(id,provider_model_id,effective_at,
        input_micros_per_million,cached_input_micros_per_million,reasoning_micros_per_million,
        output_micros_per_million,fixed_call_micros,source)
        VALUES(${priceId},${modelId},'2020-01-01',0,0,0,0,1,'cleanup-test')`;
      for (const runId of Object.values(runIds)) {
        await sql`INSERT INTO usage_runs(id,user_id,model,provider,status)
          VALUES(${runId},${ownerId},${`cleanup-${suffix}/image`},${`cleanup-${suffix}`},'completed')`;
      }
      const attachments = [
        [cleanupAttachmentId, objectKeys.cleanup, "a"],
        [messageAttachmentId, objectKeys.message, "b"],
        [generatedAttachmentId, objectKeys.generated, "c"],
      ] as const;
      for (const [id, key, sha] of attachments) {
        await sql`INSERT INTO attachments(id,owner_id,object_key,filename,mime_type,size_bytes,
          sha256,state,ingestion_status) VALUES(${id},${ownerId},${key},${`${sha}.png`},
          'image/png',68,${sha.repeat(64)},'ready','not_applicable')`;
      }
      await sql`INSERT INTO conversations(id,owner_id,title) VALUES(${conversationId},${ownerId},'Fence')`;
      await sql`INSERT INTO messages(id,conversation_id,sibling_index,role,content,idempotency_key)
        VALUES(${messageId},${conversationId},0,'user','keep','cleanup-message')`;
      await sql`INSERT INTO message_attachments(message_id,attachment_id)
        VALUES(${messageId},${messageAttachmentId})`;
      const stages = [
        [cleanupStageId, runIds.cleanup, cleanupAttachmentId, objectKeys.cleanup, "a", "attached"],
        [messageStageId, runIds.message, messageAttachmentId, objectKeys.message, "b", "attached"],
        [
          generatedStageId,
          runIds.generated,
          generatedAttachmentId,
          objectKeys.generated,
          "c",
          "cleanup_pending",
        ],
      ] as const;
      for (const [id, runId, attachmentId, key, sha, state] of stages) {
        await sql`INSERT INTO generated_object_staging(id,owner_id,usage_run_id,ordinal,object_key,
          mime_type,size_bytes,sha256,attachment_id,state,updated_at)
          VALUES(${id},${ownerId},${runId},0,${key},'image/png',68,${sha.repeat(64)},
            ${attachmentId},${state},now() - interval '5 seconds')`;
      }
      await sql`INSERT INTO generated_assets(id,owner_id,usage_run_id,provider_model_id,
        public_model_id,upstream_model_id,provider_slug,pricing_version_id,
        pricing_input_micros_per_million,pricing_cached_input_micros_per_million,
        pricing_reasoning_micros_per_million,pricing_output_micros_per_million,
        pricing_fixed_call_micros,pricing_source,attachment_id,idempotency_key,request_hash,
        operation,prompt,provider_created_at,ordinal,width,height)
        VALUES(${generatedAssetId},${ownerId},${runIds.generated},${modelId},
          ${`cleanup-${suffix}/image`},'image',${`cleanup-${suffix}`},${priceId},0,0,0,0,1,
          'cleanup-test',${generatedAttachmentId},${`cleanup-generated-${suffix}`},${
        "d".repeat(64)
      },
          'generation','keep generated',1700000000,0,1,1)`;
      await sql`INSERT INTO jobs(id,type,payload,idempotency_key)
        VALUES(${generatedJobId},'generated_object.cleanup',${
        sql.json({ stageId: generatedStageId, ownerId })
      },${`generated_object.cleanup:${generatedStageId}`})`;

      // The cleanup transaction must fence the attachment before the non-transactional S3
      // delete. While deletion is paused, both message and generated-asset reference writers
      // observe a non-ready attachment and cannot create a durable reference.
      await deleteStarted;
      await sql`INSERT INTO messages(id,conversation_id,sibling_index,role,content,idempotency_key)
        VALUES(${concurrentMessageId},${conversationId},1,'user','race','cleanup-race-message')`;
      const messageReferenceCreated = await sql.begin(async (tx) => {
        const ready = await tx`SELECT id FROM attachments WHERE id=${cleanupAttachmentId}
          AND owner_id=${ownerId} AND state='ready' AND deleted_at IS NULL FOR UPDATE`;
        if (!ready.length) return false;
        await tx`INSERT INTO message_attachments(message_id,attachment_id)
          VALUES(${concurrentMessageId},${cleanupAttachmentId})`;
        return true;
      });
      const generatedReferenceCreated = await sql.begin(async (tx) => {
        const ready = await tx`SELECT id FROM attachments WHERE id=${cleanupAttachmentId}
          AND owner_id=${ownerId} AND state='ready' AND deleted_at IS NULL FOR UPDATE`;
        if (!ready.length) return false;
        await tx`INSERT INTO generated_assets(owner_id,usage_run_id,provider_model_id,
          public_model_id,upstream_model_id,provider_slug,pricing_version_id,
          pricing_input_micros_per_million,pricing_cached_input_micros_per_million,
          pricing_reasoning_micros_per_million,pricing_output_micros_per_million,
          pricing_fixed_call_micros,pricing_source,attachment_id,idempotency_key,request_hash,
          operation,prompt,provider_created_at,ordinal,width,height)
          VALUES(${ownerId},${runIds.cleanup},${modelId},${`cleanup-${suffix}/image`},'image',
            ${`cleanup-${suffix}`},${priceId},0,0,0,0,1,'cleanup-test',${cleanupAttachmentId},
            ${`cleanup-race-${suffix}`},${"e".repeat(64)},'generation','race',1700000001,0,1,1)`;
        return true;
      });
      assertEquals(messageReferenceCreated, false);
      assertEquals(generatedReferenceCreated, false);
      releaseDelete();

      await eventually(async () => {
        const rows = await sql<{ state: string; status: string }[]>`
          SELECT s.state,j.status FROM generated_object_staging s JOIN jobs j
            ON j.idempotency_key=${`generated_object.cleanup:${cleanupStageId}`}
          WHERE s.id=${cleanupStageId}`;
        return rows[0]?.state === "cleaned" && rows[0].status === "completed";
      });
      await eventually(async () => {
        const rows = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM jobs
          WHERE idempotency_key IN (${`generated_object.cleanup:${messageStageId}`},
            ${`generated_object.cleanup:${generatedStageId}`})
            AND last_error LIKE '%durable reference%'`;
        return rows[0]?.count === 2;
      });

      assertEquals(deletes, [`/cleanup-test/${objectKeys.cleanup}`]);
      assertEquals(
        [
          ...await sql`SELECT state,deleted_at IS NOT NULL AS deleted FROM attachments
          WHERE id=${cleanupAttachmentId}`,
        ],
        [{ state: "deleted", deleted: true }],
      );
      assertEquals(
        [
          ...await sql`SELECT state,cleanup_error FROM generated_object_staging
          WHERE id=${cleanupStageId}`,
        ],
        [{ state: "cleaned", cleanup_error: null }],
      );
      assertEquals(
        [
          ...await sql`SELECT state FROM attachments WHERE id IN
          (${messageAttachmentId},${generatedAttachmentId}) ORDER BY id`,
        ],
        [{ state: "ready" }, { state: "ready" }],
      );
      assertEquals(
        [
          ...await sql`SELECT state FROM generated_object_staging WHERE id IN
          (${messageStageId},${generatedStageId}) ORDER BY id`,
        ],
        [{ state: "cleanup_pending" }, { state: "cleanup_pending" }],
      );
      const fenced = await sql<{ last_error: string }[]>`SELECT last_error FROM jobs WHERE
        idempotency_key IN (${`generated_object.cleanup:${messageStageId}`},
          ${`generated_object.cleanup:${generatedStageId}`})`;
      for (const row of fenced) assertStringIncludes(row.last_error, "durable reference");
    } finally {
      worker.kill("SIGTERM");
      const status = await worker.status;
      if (!status.success && status.code !== 143) {
        const stderr = new TextDecoder().decode(
          await worker.stderr.getReader().read().then((x) => x.value),
        );
        console.error(stderr);
      }
      await s3.shutdown();
      await sql`DELETE FROM jobs WHERE idempotency_key LIKE ${`generated_object.cleanup:%`}
        AND payload->>'ownerId'=${ownerId}`;
      await sql`DELETE FROM generated_assets WHERE id=${generatedAssetId}`;
      await sql`DELETE FROM message_attachments WHERE message_id=${messageId}`;
      await sql`DELETE FROM generated_object_staging WHERE owner_id=${ownerId}`;
      await sql`DELETE FROM attachments WHERE owner_id=${ownerId}`;
      await sql`DELETE FROM messages WHERE id=${concurrentMessageId}`;
      await sql`DELETE FROM messages WHERE id=${messageId}`;
      await sql`DELETE FROM conversations WHERE id=${conversationId}`;
      await sql`DELETE FROM usage_runs WHERE user_id=${ownerId}`;
      await sql`DELETE FROM model_price_versions WHERE id=${priceId}`;
      await sql`DELETE FROM provider_models WHERE id=${modelId}`;
      await sql`DELETE FROM providers WHERE id=${providerId}`;
      await sql`DELETE FROM users WHERE id=${ownerId}`;
      await sql.end();
    }
  },
});
