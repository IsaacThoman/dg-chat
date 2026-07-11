import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0023 upgrades released image lineage and canonicalizes image_editing",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const schema = `image_edit_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql.unsafe(`
        CREATE FUNCTION provider_model_capabilities_are_valid(candidate jsonb)
        RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
          SELECT candidate <@ '["image_generation","image_edit"]'::jsonb
        $$;
        CREATE TABLE provider_models(
          id uuid PRIMARY KEY,
          capabilities jsonb NOT NULL CHECK(provider_model_capabilities_are_valid(capabilities))
        );
        CREATE TABLE generated_asset_inputs(
          generated_asset_id uuid NOT NULL,
          attachment_id uuid NOT NULL,
          role text NOT NULL,
          ordinal smallint NOT NULL,
          PRIMARY KEY(generated_asset_id,role,ordinal),
          CONSTRAINT generated_asset_inputs_ordinal_check CHECK(ordinal BETWEEN 0 AND 9)
        );
        CREATE TABLE generated_assets(
          id uuid PRIMARY KEY,
          owner_id uuid NOT NULL,
          attachment_id uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE generated_object_staging(
          usage_run_id text NOT NULL,
          ordinal smallint NOT NULL,
          CONSTRAINT generated_object_staging_run_ordinal_uq UNIQUE(usage_run_id,ordinal),
          CONSTRAINT generated_object_staging_ordinal_check CHECK(ordinal BETWEEN 0 AND 9)
        );
        CREATE TABLE api_idempotency_requests(
          endpoint text NOT NULL,
          CONSTRAINT api_idempotency_requests_endpoint_check
            CHECK(endpoint IN ('chat.completions','responses','embeddings','audio.transcriptions',
              'audio.translations','audio.speech','images.generations'))
        );
      `);
      const modelId = crypto.randomUUID();
      const assetId = crypto.randomUUID();
      const maskId = crypto.randomUUID();
      await sql`INSERT INTO provider_models VALUES(${modelId},'["image_generation","image_edit"]')`;
      await sql`INSERT INTO generated_asset_inputs VALUES(${assetId},${maskId},'mask',0)`;

      const migration = await Deno.readTextFile(
        new URL("../migrations/0023_image_editing.sql", import.meta.url),
      );
      await sql.unsafe(migration);

      assertEquals(
        [...await sql`SELECT capabilities FROM provider_models WHERE id=${modelId}`],
        [{ capabilities: ["image_generation", "image_editing"] }],
      );
      assertEquals(
        [
          ...await sql`SELECT width,height,has_alpha FROM generated_asset_inputs
          WHERE generated_asset_id=${assetId}`,
        ],
        [{ width: 1, height: 1, has_alpha: true }],
      );
      await sql`INSERT INTO api_idempotency_requests(endpoint) VALUES('images.edits')`;
      await assertRejects(() => sql`INSERT INTO api_idempotency_requests(endpoint) VALUES('bad')`);
      await sql`INSERT INTO provider_models VALUES(${crypto.randomUUID()},'["image_editing"]')`;
      await assertRejects(() =>
        sql`INSERT INTO provider_models VALUES(${crypto.randomUUID()},'["image_edit"]')`
      );
      assertEquals(
        [
          ...await sql`
          SELECT indexname FROM pg_indexes
          WHERE schemaname=current_schema()
            AND indexname='generated_assets_owner_attachment_created_idx'`,
        ].length,
        1,
      );
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
});
