import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0045 scrubs historical tool and usage errors and constrains future failures",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const schema = `tool_refund_${crypto.randomUUID().replaceAll("-", "")}`;
    const sql = postgres(databaseUrl!, { max: 1 });
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql.unsafe(`
        CREATE TABLE tool_executions(
          id uuid PRIMARY KEY,
          owner_id uuid NOT NULL,
          tool_id text NOT NULL,
          status text NOT NULL,
          result jsonb,
          error jsonb,
          cancellation_requested_at timestamptz,
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT tool_executions_status_check CHECK (
            status IN ('pending_approval','queued','running','succeeded','failed','cancelled')
          ),
          CONSTRAINT tool_executions_check1 CHECK (error IS NULL OR status='failed')
        );
        CREATE TABLE usage_runs(
          id text PRIMARY KEY,
          user_id uuid NOT NULL,
          token_id uuid,
          status text NOT NULL DEFAULT 'completed',
          error text,
          reserved_micros bigint NOT NULL DEFAULT 0,
          provider text NOT NULL DEFAULT 'tool',
          model text NOT NULL DEFAULT 'tool/legacy',
          run_lease_token uuid,run_lease_expires_at timestamptz,
          generation_lease_token uuid,generation_lease_expires_at timestamptz
        );
        CREATE TABLE ledger_entries(
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
          usage_run_id text NOT NULL, kind text NOT NULL, amount_micros bigint NOT NULL
        );
        CREATE TABLE api_idempotency_requests(
          usage_run_id text,state text NOT NULL DEFAULT 'in_progress',
          lease_token uuid DEFAULT gen_random_uuid(),lease_expires_at timestamptz DEFAULT now(),
          response_status integer,response_headers jsonb NOT NULL DEFAULT '{}',response_body text,
          response_body_encoding text NOT NULL DEFAULT 'utf8'
            CHECK(response_body_encoding IN ('utf8','base64')),
          failure_started_stream boolean NOT NULL DEFAULT false,completed_at timestamptz,
          updated_at timestamptz NOT NULL DEFAULT now(),
          CHECK ((state='in_progress')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
          CHECK (state='in_progress' OR (completed_at IS NOT NULL AND response_status IS NOT NULL))
        );
        CREATE TABLE jobs(
          id uuid PRIMARY KEY,status text NOT NULL,last_error text,completed_at timestamptz,
          locked_at timestamptz DEFAULT now(),locked_by text DEFAULT 'migration-test'
        );
        CREATE TABLE document_embedding_batches(
          job_id uuid NOT NULL,usage_run_id text,phase text NOT NULL DEFAULT 'pre_dispatch'
        );
      `);
      const ownerId = crypto.randomUUID();
      const upstreamId = crypto.randomUUID();
      const unknownId = crypto.randomUUID();
      const queuedId = crypto.randomUUID();
      const orphanedId = crypto.randomUUID();
      const cancelledBeforeRefundId = crypto.randomUUID();
      const wrongOwnerId = crypto.randomUUID();
      const crossOwnerLedgerId = crypto.randomUUID();
      const failedReservedId = crypto.randomUUID();
      const succeededReservedId = crypto.randomUUID();
      const pendingReservedId = crypto.randomUUID();
      const mismatchedModelId = crypto.randomUUID();
      const missingLedgerId = crypto.randomUUID();
      const ambiguousToolApiId = crypto.randomUUID();
      const ambiguousToolDocumentId = crypto.randomUUID();
      const safeDocumentJobId = crypto.randomUUID();
      const ambiguousToolDocumentJobId = crypto.randomUUID();
      const ambiguousApiDocumentJobId = crypto.randomUUID();
      const otherOwnerId = crypto.randomUUID();
      const apiRunId = "api-replay-legacy";
      const documentRunId = "document-embedding-legacy";
      const ambiguousApiDocumentRunId = "ambiguous-api-document-legacy";
      const providerRunId = "provider-legacy";
      const secret = "postgres://operator:password@169.254.169.254/private";
      await sql`INSERT INTO tool_executions(id,owner_id,tool_id,status,error) VALUES
        (${upstreamId},${ownerId},'legacy','failed',${
        sql.json({ code: "request_failed", message: secret })
      }),
        (${unknownId},${ownerId},'legacy','failed',${
        sql.json({ code: "hostile", message: secret })
      }),
        (${queuedId},${ownerId},'web_search','queued',NULL),
        (${orphanedId},${ownerId},'web_search','queued',NULL),
        (${cancelledBeforeRefundId},${ownerId},'web_search','cancelled',NULL),
        (${wrongOwnerId},${ownerId},'web_search','queued',NULL),
        (${crossOwnerLedgerId},${ownerId},'web_search','queued',NULL),
        (${failedReservedId},${ownerId},'web_search','failed',${
        sql.json({ code: "hostile", message: secret })
      }),
        (${succeededReservedId},${ownerId},'web_search','succeeded',NULL),
        (${pendingReservedId},${ownerId},'web_search','pending_approval',NULL),
        (${mismatchedModelId},${ownerId},'web_search','queued',NULL),
        (${missingLedgerId},${ownerId},'web_search','queued',NULL),
        (${ambiguousToolApiId},${ownerId},'web_search','queued',NULL),
        (${ambiguousToolDocumentId},${ownerId},'web_search','queued',NULL)`;
      await sql`INSERT INTO usage_runs(id,user_id,error) VALUES
        (${`tool:${upstreamId}`},${ownerId},${secret}),
        (${`tool:${unknownId}`},${ownerId},${secret})`;
      await sql`INSERT INTO usage_runs(id,user_id,error,reserved_micros,provider,model,status) VALUES
        (${`tool:${queuedId}`},${ownerId},NULL,4321,'tool','tool/web_search','reserved'),
        (${`tool:${cancelledBeforeRefundId}`},${ownerId},NULL,111,'tool','tool/web_search','reserved'),
        (${`tool:${wrongOwnerId}`},${otherOwnerId},NULL,222,'tool','tool/web_search','reserved'),
        (${`tool:${crossOwnerLedgerId}`},${ownerId},NULL,223,'tool','tool/web_search','reserved'),
        (${`tool:${failedReservedId}`},${ownerId},NULL,333,'tool','tool/web_search','reserved'),
        (${`tool:${succeededReservedId}`},${ownerId},NULL,444,'tool','tool/web_search','reserved'),
        (${`tool:${pendingReservedId}`},${ownerId},NULL,555,'tool','tool/web_search','reserved'),
        (${`tool:${mismatchedModelId}`},${ownerId},NULL,666,'tool','tool/other','reserved'),
        (${`tool:${missingLedgerId}`},${ownerId},NULL,777,'tool','tool/web_search','reserved'),
        (${`tool:${ambiguousToolApiId}`},${ownerId},NULL,888,'tool','tool/web_search','reserved'),
        (${`tool:${ambiguousToolDocumentId}`},${ownerId},NULL,999,'tool','tool/web_search','reserved'),
        (${apiRunId},${ownerId},NULL,0,'api','api/model','completed'),
        (${documentRunId},${ownerId},NULL,0,'embedding:test','embedding/model','completed'),
        (${ambiguousApiDocumentRunId},${ownerId},NULL,123,'api','api/model','reserved'),
        (${providerRunId},${ownerId},NULL,0,'openai','chat/model','completed')`;
      await sql`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros)
        VALUES(${ownerId},${`tool:${queuedId}`},'reserve',-4321),
          (${ownerId},${`tool:${cancelledBeforeRefundId}`},'reserve',-111),
          (${otherOwnerId},${`tool:${wrongOwnerId}`},'reserve',-222),
          (${ownerId},${`tool:${crossOwnerLedgerId}`},'reserve',-223),
          (${otherOwnerId},${`tool:${crossOwnerLedgerId}`},'grant',0),
          (${ownerId},${`tool:${failedReservedId}`},'reserve',-333),
          (${ownerId},${`tool:${succeededReservedId}`},'reserve',-444),
          (${ownerId},${`tool:${pendingReservedId}`},'reserve',-555),
          (${ownerId},${`tool:${mismatchedModelId}`},'reserve',-666),
          (${ownerId},${`tool:${ambiguousToolApiId}`},'reserve',-888),
          (${ownerId},${`tool:${ambiguousToolDocumentId}`},'reserve',-999),
          (${ownerId},${ambiguousApiDocumentRunId},'reserve',-123)`;
      await sql`INSERT INTO api_idempotency_requests(usage_run_id) VALUES(${apiRunId}),
        (${`tool:${ambiguousToolApiId}`}),(${ambiguousApiDocumentRunId})`;
      await sql`UPDATE api_idempotency_requests SET response_body='e30=',
        response_body_encoding='base64' WHERE usage_run_id=${`tool:${ambiguousToolApiId}`}`;
      await sql`INSERT INTO jobs(id,status) VALUES(${safeDocumentJobId},'running'),
        (${ambiguousToolDocumentJobId},'running'),(${ambiguousApiDocumentJobId},'queued')`;
      await sql`INSERT INTO document_embedding_batches(job_id,usage_run_id) VALUES
        (${safeDocumentJobId},${documentRunId}),
        (${ambiguousToolDocumentJobId},${`tool:${ambiguousToolDocumentId}`}),
        (${ambiguousApiDocumentJobId},${ambiguousApiDocumentRunId})`;

      const migration = await Deno.readTextFile(
        new URL("../migrations/0045_tool_refund_outbox.sql", import.meta.url),
      );
      await sql.unsafe(migration);

      assertEquals(
        [
          ...await sql`SELECT id::text,error FROM tool_executions
          WHERE id IN (${upstreamId},${unknownId}) ORDER BY id::text`,
        ],
        [
          {
            id: [unknownId, upstreamId].sort()[0],
            error: [unknownId, upstreamId].sort()[0] === unknownId
              ? { code: "tool_execution_failed", message: "Tool execution failed" }
              : {
                code: "tool_upstream_unavailable",
                message: "Tool service is unavailable",
              },
          },
          {
            id: [unknownId, upstreamId].sort()[1],
            error: [unknownId, upstreamId].sort()[1] === unknownId
              ? { code: "tool_execution_failed", message: "Tool execution failed" }
              : {
                code: "tool_upstream_unavailable",
                message: "Tool service is unavailable",
              },
          },
        ],
      );
      assertEquals(
        [
          ...await sql<{ id: string; recovery_owner: string }[]>`
          SELECT id,recovery_owner FROM usage_runs
          WHERE id IN (${apiRunId},${documentRunId},${providerRunId},
            ${`tool:${ambiguousToolApiId}`},${`tool:${ambiguousToolDocumentId}`},
            ${ambiguousApiDocumentRunId}) ORDER BY id`,
        ],
        [
          { id: ambiguousApiDocumentRunId, recovery_owner: "provider" },
          { id: apiRunId, recovery_owner: "api_replay" },
          { id: documentRunId, recovery_owner: "document_embedding" },
          { id: providerRunId, recovery_owner: "provider" },
          { id: `tool:${ambiguousToolApiId}`, recovery_owner: "provider" },
          { id: `tool:${ambiguousToolDocumentId}`, recovery_owner: "provider" },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );
      assertEquals(
        [
          ...await sql<{ id: string; status: string; billing_snapshot: unknown }[]>`
            SELECT id::text,status,billing_snapshot FROM tool_executions
            WHERE id IN (${ambiguousToolApiId},${ambiguousToolDocumentId}) ORDER BY id::text`,
        ],
        [ambiguousToolApiId, ambiguousToolDocumentId].sort().map((id) => ({
          id,
          status: "failed",
          billing_snapshot: null,
        })),
      );
      assertEquals(
        [
          ...await sql<{
            usage_run_id: string;
            state: string;
            lease_active: boolean;
            response_status: number | null;
            response_body_encoding: string;
          }[]>`
            SELECT usage_run_id,state,lease_token IS NOT NULL AS lease_active,response_status,
              response_body_encoding
            FROM api_idempotency_requests ORDER BY usage_run_id`,
        ],
        [{
          usage_run_id: ambiguousApiDocumentRunId,
          state: "failed",
          lease_active: false,
          response_status: 500,
          response_body_encoding: "utf8",
        }, {
          usage_run_id: apiRunId,
          state: "in_progress",
          lease_active: true,
          response_status: null,
          response_body_encoding: "utf8",
        }, {
          usage_run_id: `tool:${ambiguousToolApiId}`,
          state: "failed",
          lease_active: false,
          response_status: 500,
          response_body_encoding: "utf8",
        }].sort((left, right) => left.usage_run_id.localeCompare(right.usage_run_id)),
      );
      assertEquals(
        [...await sql`SELECT usage_run_id FROM document_embedding_batches ORDER BY usage_run_id`],
        [{ usage_run_id: documentRunId }],
      );
      assertEquals(
        [
          ...await sql<{ id: string; status: string; locked_by: string | null }[]>`
            SELECT id::text,status,locked_by FROM jobs ORDER BY id::text`,
        ].sort((left, right) => left.id.localeCompare(right.id)),
        [{ id: safeDocumentJobId, status: "running", locked_by: "migration-test" }, {
          id: ambiguousToolDocumentJobId,
          status: "failed",
          locked_by: null,
        }, {
          id: ambiguousApiDocumentJobId,
          status: "failed",
          locked_by: null,
        }].sort((left, right) => left.id.localeCompare(right.id)),
      );
      // Failed replay records remain deterministic until normal retention pruning. Once pruned,
      // every ambiguous reservation satisfies the provider reaper's expired-lease and
      // no-active-specialized-claim predicates.
      await sql`DELETE FROM api_idempotency_requests WHERE state='failed'`;
      assertEquals(
        [
          ...await sql<{ id: string }[]>`
            SELECT usage.id FROM usage_runs AS usage
            WHERE usage.id IN (${`tool:${ambiguousToolApiId}`},
                ${`tool:${ambiguousToolDocumentId}`},${ambiguousApiDocumentRunId})
              AND usage.status='reserved' AND usage.recovery_owner='provider'
              AND usage.run_lease_token IS NOT NULL AND usage.run_lease_expires_at<=now()
              AND usage.generation_lease_token IS NULL
              AND NOT EXISTS(SELECT 1 FROM api_idempotency_requests AS request
                WHERE request.usage_run_id=usage.id)
              AND NOT EXISTS(SELECT 1 FROM document_embedding_batches AS batch
                JOIN jobs AS job ON job.id=batch.job_id
                WHERE batch.usage_run_id=usage.id
                  AND batch.phase IN ('pre_dispatch','dispatched','succeeded')
                  AND job.status IN ('queued','running'))
            ORDER BY usage.id`,
        ],
        [ambiguousApiDocumentRunId, `tool:${ambiguousToolApiId}`, `tool:${ambiguousToolDocumentId}`]
          .sort().map((id) => ({ id })),
      );
      assertEquals(
        (await sql<{ status: string; billing_snapshot: unknown }[]>`
          SELECT status,billing_snapshot FROM tool_executions
          WHERE id=${cancelledBeforeRefundId}`)[0],
        {
          status: "cancelled_pending_refund",
          billing_snapshot: {
            model: "tool/web_search",
            provider: "tool",
            reservedMicros: 111,
          },
        },
      );
      assertEquals(
        (await sql<{ status: string; billing_snapshot: unknown }[]>`
          SELECT status,billing_snapshot FROM tool_executions WHERE id=${wrongOwnerId}`)[0],
        { status: "failed", billing_snapshot: null },
      );
      assertEquals(
        (await sql<{ status: string; billing_snapshot: unknown }[]>`
          SELECT status,billing_snapshot FROM tool_executions WHERE id=${crossOwnerLedgerId}`)[0],
        { status: "failed", billing_snapshot: null },
      );
      assertEquals(
        [
          ...await sql<{ id: string; status: string; billing_snapshot: unknown }[]>`
            SELECT id::text,status,billing_snapshot FROM tool_executions
            WHERE id IN (${failedReservedId},${succeededReservedId},${pendingReservedId},
              ${mismatchedModelId},${missingLedgerId}) ORDER BY id::text`,
        ].map((row) => ({
          ...row,
          id: ({
            [failedReservedId]: "failed",
            [succeededReservedId]: "succeeded",
            [pendingReservedId]: "pending",
            [mismatchedModelId]: "mismatch",
            [missingLedgerId]: "missing-ledger",
          } as Record<string, string>)[row.id],
        })).sort((a, b) => a.id.localeCompare(b.id)),
        [
          {
            id: "failed",
            status: "failed_pending_refund",
            billing_snapshot: { model: "tool/web_search", provider: "tool", reservedMicros: 333 },
          },
          {
            id: "mismatch",
            status: "cancelled_pending_refund",
            billing_snapshot: { model: "tool/other", provider: "tool", reservedMicros: 666 },
          },
          { id: "missing-ledger", status: "failed", billing_snapshot: null },
          {
            id: "pending",
            status: "cancelled_pending_refund",
            billing_snapshot: { model: "tool/web_search", provider: "tool", reservedMicros: 555 },
          },
          {
            id: "succeeded",
            status: "succeeded_pending_settlement",
            billing_snapshot: { model: "tool/web_search", provider: "tool", reservedMicros: 444 },
          },
        ].sort((a, b) => a.id.localeCompare(b.id)),
      );
      assertEquals(
        [...await sql`SELECT id,error FROM usage_runs WHERE error IS NOT NULL ORDER BY id`],
        [
          {
            id: `tool:${[unknownId, upstreamId].sort()[0]}`,
            error: [unknownId, upstreamId].sort()[0] === unknownId
              ? "Tool execution failed"
              : "Tool service is unavailable",
          },
          {
            id: `tool:${[unknownId, upstreamId].sort()[1]}`,
            error: [unknownId, upstreamId].sort()[1] === unknownId
              ? "Tool execution failed"
              : "Tool service is unavailable",
          },
        ],
      );
      assertEquals(
        JSON.stringify(
          await sql`SELECT error FROM tool_executions UNION ALL
          SELECT to_jsonb(error) FROM usage_runs`,
        ).includes(secret),
        false,
      );

      const rejected = await assertRejects(() =>
        sql`UPDATE tool_executions SET error=${
          sql.json({
            code: "tool_execution_failed",
            message: secret,
          })
        } WHERE id=${unknownId}`
      );
      assertEquals((rejected as { code?: string }).code, "23514");
      await sql`UPDATE tool_executions SET error=${
        sql.json({
          code: "tool_timeout",
          message: "Tool service timed out",
        })
      } WHERE id=${unknownId}`;
      assertEquals(
        (await sql<{ status: string; billing_snapshot: unknown }[]>`
          SELECT status,billing_snapshot FROM tool_executions WHERE id=${queuedId}`)[0],
        {
          status: "queued",
          billing_snapshot: {
            model: "tool/web_search",
            provider: "tool",
            reservedMicros: 4321,
          },
        },
      );
      assertEquals(
        (await sql<{ status: string; error: unknown }[]>`
          SELECT status,error FROM tool_executions WHERE id=${orphanedId}`)[0],
        {
          status: "failed",
          error: { code: "tool_execution_failed", message: "Tool execution failed" },
        },
      );
      const immutable = await assertRejects(() =>
        sql`UPDATE tool_executions SET billing_snapshot=${
          sql.json({ reservedMicros: 9999, provider: "tool", model: "tool/web_search" })
        } WHERE id=${queuedId}`
      );
      assertEquals((immutable as { code?: string }).code, "23514");
      const malformed = await assertRejects(() =>
        sql`UPDATE tool_executions SET billing_snapshot=${
          sql.json({ reservedMicros: 1.5, provider: "tool", model: "tool/web_search" })
        } WHERE id=${unknownId}`
      );
      assertEquals((malformed as { code?: string }).code, "23514");
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
});
