import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0050 backfills unique retained blobs and enforces cumulative accounting",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const schema = `attachment_control_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql.unsafe(`
        CREATE TABLE users(id uuid PRIMARY KEY);
        CREATE TABLE usage_runs(
          id text NOT NULL,
          user_id uuid NOT NULL,
          UNIQUE(user_id,id)
        );
        CREATE TABLE attachments(
          id uuid PRIMARY KEY,
          owner_id uuid NOT NULL REFERENCES users(id),
          object_key text NOT NULL,
          filename text NOT NULL,
          mime_type text NOT NULL,
          size_bytes bigint NOT NULL,
          sha256 text NOT NULL,
          state text NOT NULL,
          inspection_error text,
          ingestion_status text NOT NULL DEFAULT 'not_applicable',
          ingestion_error text,
          ingested_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          deleted_at timestamptz,
          UNIQUE(owner_id,id)
        );
        CREATE TABLE file_upload_staging(
          request_id uuid PRIMARY KEY,
          owner_id uuid NOT NULL,
          object_key text NOT NULL,
          attachment_id uuid,
          attachment_state text NOT NULL,
          CONSTRAINT file_upload_staging_attachment_state_check
            CHECK(attachment_state IN ('ready','quarantined'))
        );
        CREATE TABLE generated_object_staging(
          id uuid PRIMARY KEY,
          owner_id uuid NOT NULL,
          usage_run_id text NOT NULL,
          object_key text NOT NULL,
          mime_type text NOT NULL,
          size_bytes bigint NOT NULL,
          sha256 text NOT NULL,
          attachment_id uuid,
          state text NOT NULL,
          cleanup_attachment boolean NOT NULL DEFAULT true,
          cleanup_error text,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE message_attachments(attachment_id uuid NOT NULL);
        CREATE TABLE knowledge_collection_attachments(attachment_id uuid NOT NULL);
        CREATE TABLE document_chunks(attachment_id uuid NOT NULL);
        CREATE TABLE generated_assets(attachment_id uuid NOT NULL,usage_run_id text NOT NULL);
        CREATE TABLE generated_asset_inputs(attachment_id uuid NOT NULL);
        CREATE TABLE conversation_share_snapshots(
          source_attachments jsonb NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE TABLE audit_events(
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          actor_id uuid,action text NOT NULL,target_type text NOT NULL,target_id text,
          metadata jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE FUNCTION dg_chat_restore_transaction_authorized(name) RETURNS boolean
          LANGUAGE sql AS
          'SELECT current_setting(''dg_chat.test_restore_authorized'',true)=''on''';
        CREATE FUNCTION dg_chat_enforce_restore_maintenance() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      `);
      const owner = crypto.randomUUID();
      const first = crypto.randomUUID();
      const duplicate = crypto.randomUUID();
      const manifestOnly = crypto.randomUUID();
      const noncanonicalLookalike = crypto.randomUUID();
      await sql`INSERT INTO users(id) VALUES(${owner})`;
      await sql`INSERT INTO attachments(
        id,owner_id,object_key,filename,mime_type,size_bytes,sha256,state,
        inspection_error,ingestion_status,ingestion_error,deleted_at)
        VALUES(${first},${owner},'retained/a','a.txt','text/plain',20,${
        "a".repeat(64)
      },'ready',NULL,'not_applicable',NULL,NULL),
          (${duplicate},${owner},'retained/a','copy.txt','text/plain',20,${
        "a".repeat(64)
      },'deleted',NULL,'not_applicable',NULL,now()),
          (${manifestOnly},${owner},${`imports/${owner}/${manifestOnly}/manifest-only`},
            'metadata.txt','text/plain',99,${"c".repeat(64)},'failed',
            'Attachment bytes were not included in the .dgchat manifest','failed',
            'Attachment bytes require a separate restore',now()),
          (${noncanonicalLookalike},${owner},'retained/a','lookalike.txt','text/plain',20,
            ${"a".repeat(64)},'failed',
            'Attachment bytes were not included in the .dgchat manifest','failed',
            'Attachment bytes require a separate restore',now())`;

      const migration = await Deno.readTextFile(
        new URL("../migrations/0050_attachment_control_plane.sql", import.meta.url),
      );
      await sql.unsafe(migration);
      await sql`SELECT set_config('dg_chat.test_restore_authorized','off',false)`;
      assertEquals(
        [...await sql`SELECT physical_bytes,physical_objects FROM attachment_storage_installation`]
          .map((row) => ({
            physical_bytes: Number(row.physical_bytes),
            physical_objects: Number(row.physical_objects),
          })),
        [{ physical_bytes: 20, physical_objects: 1 }],
      );
      assertEquals(
        [
          ...await sql`SELECT id,physical_object FROM attachments
            WHERE id IN (${manifestOnly},${noncanonicalLookalike}) ORDER BY id`,
        ],
        [{
          id: manifestOnly,
          physical_object: false,
        }, {
          id: noncanonicalLookalike,
          physical_object: true,
        }].sort((left, right) => left.id.localeCompare(right.id)),
      );
      const next = crypto.randomUUID();
      await sql`INSERT INTO attachments(
        id,owner_id,object_key,filename,mime_type,size_bytes,sha256,state)
        VALUES(${next},${owner},'retained/b','b.txt','text/plain',30,${"b".repeat(64)},'ready')`;
      await sql`DELETE FROM attachments WHERE id=${next}`;
      assertEquals(
        Number(
          (await sql`SELECT physical_bytes FROM attachment_storage_usage WHERE owner_id=${owner}`)[
            0
          ]
            .physical_bytes,
        ),
        50,
      );
      await assertRejects(() =>
        sql`UPDATE attachment_storage_blobs SET size_bytes=0 WHERE owner_id=${owner}`
      );
      await assertRejects(() =>
        sql`SELECT dg_chat_admit_attachment_storage(
          ${owner},'retained/c',1,${"c".repeat(64)},'text/plain',50,100,50,100
        )`
      );
      await assertRejects(
        () =>
          sql`SELECT dg_chat_admit_attachment_storage(
            ${owner},'retained/a',20,${"a".repeat(64)},'application/json',
            NULL,NULL,NULL,NULL
          )`,
        Error,
        "metadata differs",
      );
      const cleanupAttachment = crypto.randomUUID();
      const cleanupStage = crypto.randomUUID();
      await sql`INSERT INTO attachments(
        id,owner_id,object_key,filename,mime_type,size_bytes,sha256,state)
        VALUES(${cleanupAttachment},${owner},'retained/reclaim','reclaim.png','image/png',7,
          ${"d".repeat(64)},'ready')`;
      await sql`INSERT INTO generated_object_staging(
        id,owner_id,usage_run_id,object_key,mime_type,size_bytes,sha256,attachment_id,state,
        cleanup_attachment)
        VALUES(${cleanupStage},${owner},'cleanup-run','retained/reclaim','image/png',7,
          ${"d".repeat(64)},${cleanupAttachment},'cleaning',true)`;
      await sql`INSERT INTO usage_runs(id,user_id) VALUES('cleanup-run',${owner})`;
      await sql`UPDATE attachments SET state='deleted',deleted_at=now()
        WHERE id=${cleanupAttachment}`;
      assertEquals(
        Boolean(
          (await sql`SELECT dg_chat_settle_generated_object_cleanup(
            ${cleanupStage},${owner}
          ) released`)[0].released,
        ),
        true,
      );
      assertEquals(
        [
          ...await sql`SELECT physical_bytes,physical_objects FROM attachment_storage_usage
          WHERE owner_id=${owner}`,
        ].map((row) => ({
          physical_bytes: Number(row.physical_bytes),
          physical_objects: Number(row.physical_objects),
        })),
        [{ physical_bytes: 50, physical_objects: 2 }],
      );
      assertEquals(
        Boolean(
          (await sql`SELECT dg_chat_settle_generated_object_cleanup(
            ${cleanupStage},${owner}
          ) released`)[0].released,
        ),
        false,
      );
      assertEquals(
        [
          ...await sql`SELECT stage_id,attachment_id,reason FROM attachment_storage_releases
          WHERE stage_id=${cleanupStage}`,
        ],
        [{
          stage_id: cleanupStage,
          attachment_id: cleanupAttachment,
          reason: "generated_object_cleanup",
        }],
      );
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM audit_events
            WHERE action='attachment.storage_reclaimed' AND target_id=${cleanupAttachment}`)[0]
            .count,
        ),
        1,
      );
      assertEquals(
        (await sql<{ metadata: Record<string, unknown> }[]>`
          SELECT metadata FROM audit_events
          WHERE action='attachment.storage_reclaimed' AND target_id=${cleanupAttachment}
        `)[0].metadata,
        { sizeBytes: 7, stageId: cleanupStage },
      );
      await assertRejects(() =>
        sql`UPDATE attachment_storage_releases SET reason='generated_object_cleanup'
          WHERE stage_id=${cleanupStage}`
      );
      await assertRejects(() =>
        sql`DELETE FROM attachment_storage_releases WHERE stage_id=${cleanupStage}`
      );
      const otherOwner = crypto.randomUUID();
      await sql`INSERT INTO users(id) VALUES(${otherOwner})`;
      await assertRejects(() =>
        sql`UPDATE attachments SET owner_id=${otherOwner} WHERE id=${first}`
      );
      await assertRejects(() =>
        sql`UPDATE attachments SET object_key='retained/tampered' WHERE id=${first}`
      );
      await assertRejects(() => sql`UPDATE attachments SET size_bytes=21 WHERE id=${first}`);
      await assertRejects(() =>
        sql`UPDATE attachments SET sha256=${"f".repeat(64)} WHERE id=${first}`
      );
      const restored = await sql.begin(async (tx) => {
        await tx`SELECT set_config('dg_chat.test_restore_authorized','on',true)`;
        assertEquals(
          Boolean(
            (await tx`SELECT dg_chat_restore_transaction_authorized(
              current_schema()::name
            ) authorized`)[0].authorized,
          ),
          true,
        );
        return (await tx`
          UPDATE attachments SET object_key='retained/restored' WHERE id=${first}
          RETURNING object_key
        `)[0];
      });
      assertEquals(String(restored.object_key), "retained/restored");
      await sql`DELETE FROM attachment_storage_installation WHERE singleton_id=1`;
      await assertRejects(
        () =>
          sql`SELECT dg_chat_admit_attachment_storage(
            ${owner},'retained/missing-singleton',1,${"e".repeat(64)},'text/plain',
            NULL,NULL,NULL,NULL
          )`,
        Error,
        "installation state is missing",
      );
      const columns = await sql<{ column_name: string; column_default: string }[]>`
        SELECT column_name,column_default FROM information_schema.columns
        WHERE table_schema=${schema} AND table_name='attachments'
          AND column_name IN ('inspection_epoch','version') ORDER BY column_name`;
      assertEquals(columns.map((row) => row.column_name), ["inspection_epoch", "version"]);
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
});
