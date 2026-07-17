import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

async function applyMigration(sql: postgres.Sql, filename: string) {
  const migration = await Deno.readTextFile(
    new URL(`../migrations/${filename}`, import.meta.url),
  );
  await sql.unsafe(migration);
}

async function createPre0050Fixture(sql: postgres.Sql) {
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
}

Deno.test({
  name: "0049 upgrades through attachment control latest with exact release accounting",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const schema = `attachment_control_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await createPre0050Fixture(sql);
      const owner = crypto.randomUUID();
      const first = crypto.randomUUID();
      const duplicate = crypto.randomUUID();
      const manifestOnly = crypto.randomUUID();
      const noncanonicalLookalike = crypto.randomUUID();
      const historicalOwner = crypto.randomUUID();
      const historicallyReleased = crypto.randomUUID();
      const historicalStage = crypto.randomUUID();
      await sql`INSERT INTO users(id) VALUES(${owner}),(${historicalOwner})`;
      await sql`INSERT INTO usage_runs(id,user_id)
        VALUES('historical-cleanup-run',${historicalOwner})`;
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
            'Attachment bytes require a separate restore',now()),
          (${historicallyReleased},${historicalOwner},'generated/deleted','deleted.png',
            'image/png',7,
            ${"d".repeat(64)},'deleted',NULL,'not_applicable',NULL,now())`;
      await sql`INSERT INTO generated_object_staging(
        id,owner_id,usage_run_id,object_key,mime_type,size_bytes,sha256,attachment_id,state,
        cleanup_attachment,cleanup_error)
        VALUES(${historicalStage},${historicalOwner},'historical-cleanup-run','generated/deleted',
          'image/png',7,${"d".repeat(64)},${historicallyReleased},'cleaned',true,NULL)`;

      await applyMigration(sql, "0050_attachment_control_plane.sql");
      await applyMigration(sql, "0051_attachment_release_compatibility.sql");
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
      assertEquals(
        [
          ...await sql<{
            stage_id: string;
            usage_run_id: string;
            owner_id: string;
            object_key: string;
            attachment_id: string;
            size_bytes: string;
            sha256: string;
            mime_type: string;
            reason: string;
          }[]>`SELECT stage_id,usage_run_id,owner_id,object_key,attachment_id,size_bytes,
            sha256,mime_type,reason
          FROM attachment_storage_releases WHERE stage_id=${historicalStage}`,
        ].map((row) => ({ ...row, size_bytes: Number(row.size_bytes) })),
        [{
          stage_id: historicalStage,
          usage_run_id: "historical-cleanup-run",
          owner_id: historicalOwner,
          object_key: "generated/deleted",
          attachment_id: historicallyReleased,
          size_bytes: 7,
          sha256: "d".repeat(64),
          mime_type: "image/png",
          reason: "generated_object_cleanup",
        }],
      );
      assertEquals(
        [
          ...await sql`SELECT blob.object_key
            FROM attachment_storage_blobs blob
            LEFT JOIN attachment_storage_releases release
              ON release.owner_id=blob.owner_id AND release.object_key=blob.object_key
            WHERE release.id IS NULL ORDER BY blob.object_key`,
        ].map((row) => String(row.object_key)),
        ["retained/a"],
      );
      assertEquals(
        [
          ...await sql`SELECT owner_id,physical_bytes,physical_objects
            FROM attachment_storage_usage WHERE owner_id=${historicalOwner}`,
        ].map((row) => ({
          owner_id: String(row.owner_id),
          physical_bytes: Number(row.physical_bytes),
          physical_objects: Number(row.physical_objects),
        })),
        [{ owner_id: historicalOwner, physical_bytes: 0, physical_objects: 0 }],
      );
      assertEquals(
        (await sql<{ metadata: Record<string, unknown> }[]>`
          SELECT metadata FROM audit_events
          WHERE action='attachment.storage_reclaimed' AND target_id=${historicallyReleased}
        `)[0].metadata,
        { migrationBackfill: true, sizeBytes: 7, stageId: historicalStage },
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
      // postgres.js can reserve a different pooled connection for begin(); reassert the fixture
      // schema before the remaining session-scoped checks.
      await sql.unsafe(`SET search_path TO ${schema},public`);
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

Deno.test({
  name: "0051 upgrades original 0050 data and authorizes only bound restore inserts",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const schema = `attachment_0051_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await createPre0050Fixture(sql);
      const owner = crypto.randomUUID();
      const attachment = crypto.randomUUID();
      const stage = crypto.randomUUID();
      await sql`INSERT INTO users(id) VALUES(${owner})`;
      await sql`INSERT INTO usage_runs(id,user_id) VALUES('legacy-cleanup-run',${owner})`;
      await sql`INSERT INTO attachments(
        id,owner_id,object_key,filename,mime_type,size_bytes,sha256,state,deleted_at)
        VALUES(${attachment},${owner},'generated/legacy-cleaned','legacy.png','image/png',13,
          ${"a".repeat(64)},'deleted',now())`;
      await sql`INSERT INTO generated_object_staging(
        id,owner_id,usage_run_id,object_key,mime_type,size_bytes,sha256,attachment_id,state,
        cleanup_attachment,cleanup_error)
        VALUES(${stage},${owner},'legacy-cleanup-run','generated/legacy-cleaned','image/png',13,
          ${"a".repeat(64)},${attachment},'cleaned',true,NULL)`;

      await applyMigration(sql, "0050_attachment_control_plane.sql");
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM attachment_storage_releases`)[0].count,
        ),
        0,
      );
      assertEquals(
        [
          ...await sql`SELECT physical_bytes,physical_objects
          FROM attachment_storage_installation`,
        ].map((row) => ({
          physical_bytes: Number(row.physical_bytes),
          physical_objects: Number(row.physical_objects),
        })),
        [{ physical_bytes: 13, physical_objects: 1 }],
      );

      await applyMigration(sql, "0051_attachment_release_compatibility.sql");
      assertEquals(
        [
          ...await sql`SELECT stage_id,attachment_id FROM attachment_storage_releases
            WHERE stage_id=${stage}`,
        ],
        [{ stage_id: stage, attachment_id: attachment }],
      );
      assertEquals(
        [
          ...await sql`SELECT physical_bytes,physical_objects
          FROM attachment_storage_installation`,
        ].map((row) => ({
          physical_bytes: Number(row.physical_bytes),
          physical_objects: Number(row.physical_objects),
        })),
        [{ physical_bytes: 0, physical_objects: 0 }],
      );

      await assertRejects(
        () =>
          sql`INSERT INTO attachments(
            id,owner_id,object_key,filename,mime_type,size_bytes,sha256,state)
            VALUES(${crypto.randomUUID()},${owner},'generated/legacy-cleaned','reuse.png',
              'image/png',13,${"a".repeat(64)},'ready')`,
        Error,
        "released attachment object keys cannot be reused",
      );

      const restoredAttachment = crypto.randomUUID();
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('dg_chat.test_restore_authorized','on',true)`;
        await tx`INSERT INTO attachments(
          id,owner_id,object_key,filename,mime_type,size_bytes,sha256,state)
          VALUES(${restoredAttachment},${owner},'generated/legacy-cleaned','restored.png',
            'image/png',13,${"a".repeat(64)},'deleted')`;
      });
      await sql.unsafe(`SET search_path TO ${schema},public`);
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM attachments
            WHERE id=${restoredAttachment}`)[0].count,
        ),
        1,
      );
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
});

Deno.test({
  name: "0051 fails closed when historical generated cleanup still has a durable reference",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const schema = `attachment_control_ambiguous_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await createPre0050Fixture(sql);
      const owner = crypto.randomUUID();
      const attachment = crypto.randomUUID();
      const stage = crypto.randomUUID();
      await sql`INSERT INTO users(id) VALUES(${owner})`;
      await sql`INSERT INTO usage_runs(id,user_id) VALUES('ambiguous-cleanup-run',${owner})`;
      await sql`INSERT INTO attachments(
        id,owner_id,object_key,filename,mime_type,size_bytes,sha256,state,deleted_at)
        VALUES(${attachment},${owner},'generated/ambiguous','ambiguous.png','image/png',11,
          ${"e".repeat(64)},'deleted',now())`;
      await sql`INSERT INTO generated_object_staging(
        id,owner_id,usage_run_id,object_key,mime_type,size_bytes,sha256,attachment_id,state,
        cleanup_attachment,cleanup_error)
        VALUES(${stage},${owner},'ambiguous-cleanup-run','generated/ambiguous','image/png',11,
          ${"e".repeat(64)},${attachment},'cleaned',true,NULL)`;
      await sql`INSERT INTO message_attachments(attachment_id) VALUES(${attachment})`;

      await applyMigration(sql, "0050_attachment_control_plane.sql");
      await assertRejects(
        () => applyMigration(sql, "0051_attachment_release_compatibility.sql"),
        Error,
        "historical cleaned generated object is fenced by ambiguous durable state",
      );
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
});
