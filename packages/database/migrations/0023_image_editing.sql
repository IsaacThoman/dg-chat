-- Forward-only image editing capability and immutable input inspection snapshots.
CREATE OR REPLACE FUNCTION provider_model_capabilities_are_valid(candidate jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT jsonb_typeof(candidate) = 'array'
    AND candidate <@ '["chat","streaming","vision","tools","reasoning","embeddings","audio_input","transcription","translation","speech","image_generation","image_edit","image_editing"]'::jsonb
    AND jsonb_array_length(candidate) = (
      SELECT count(DISTINCT value) FROM jsonb_array_elements_text(candidate) capability(value)
    )
$$;

UPDATE provider_models SET capabilities=(
  SELECT jsonb_agg(CASE WHEN value='image_edit' THEN 'image_editing' ELSE value END ORDER BY ordinal)
  FROM jsonb_array_elements_text(capabilities) WITH ORDINALITY AS item(value,ordinal)
) WHERE capabilities ? 'image_edit';

CREATE OR REPLACE FUNCTION provider_model_capabilities_are_valid(candidate jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT jsonb_typeof(candidate) = 'array'
    AND candidate <@ '["chat","streaming","vision","tools","reasoning","embeddings","audio_input","transcription","translation","speech","image_generation","image_editing"]'::jsonb
    AND jsonb_array_length(candidate) = (
      SELECT count(DISTINCT value) FROM jsonb_array_elements_text(candidate) capability(value)
    )
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM generated_asset_inputs
    GROUP BY generated_asset_id,attachment_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'generated_asset_inputs contains duplicate attachment lineage'
      USING HINT = 'Assign each attachment exactly one role per generated asset before migration 0023.';
  END IF;
END $$;

ALTER TABLE generated_asset_inputs
  ADD COLUMN width integer NOT NULL DEFAULT 1,
  ADD COLUMN height integer NOT NULL DEFAULT 1,
  ADD COLUMN has_alpha boolean;
UPDATE generated_asset_inputs SET has_alpha=true WHERE role='mask';
ALTER TABLE generated_asset_inputs
  ALTER COLUMN width DROP DEFAULT,
  ALTER COLUMN height DROP DEFAULT,
  ADD CONSTRAINT generated_asset_inputs_asset_attachment_uq
    UNIQUE(generated_asset_id,attachment_id),
  ADD CONSTRAINT generated_asset_inputs_dimensions_check CHECK(
    width BETWEEN 1 AND 65535 AND height BETWEEN 1 AND 65535),
  ADD CONSTRAINT generated_asset_inputs_alpha_check CHECK(
    (role='mask' AND has_alpha IS TRUE) OR (role<>'mask' AND has_alpha IS NULL));

CREATE INDEX generated_assets_owner_attachment_created_idx
  ON generated_assets(owner_id,attachment_id,created_at DESC,id DESC);

ALTER TABLE generated_asset_inputs
  DROP CONSTRAINT generated_asset_inputs_ordinal_check,
  ADD CONSTRAINT generated_asset_inputs_ordinal_check CHECK(ordinal BETWEEN 0 AND 15);

ALTER TABLE generated_object_staging
  ADD COLUMN purpose text NOT NULL DEFAULT 'output',
  ADD COLUMN cleanup_attachment boolean NOT NULL DEFAULT true,
  DROP CONSTRAINT generated_object_staging_run_ordinal_uq,
  DROP CONSTRAINT generated_object_staging_ordinal_check,
  ADD CONSTRAINT generated_object_staging_purpose_check CHECK(purpose IN ('output','edit_input')),
  ADD CONSTRAINT generated_object_staging_run_purpose_ordinal_uq
    UNIQUE(usage_run_id,purpose,ordinal),
  -- Image edits accept sixteen sources plus one mask. Sources occupy 0..15 and
  -- the optional mask is staged at 16 before its durable lineage ordinal is reset to 0.
  ADD CONSTRAINT generated_object_staging_ordinal_check CHECK(ordinal BETWEEN 0 AND 16);
ALTER TABLE api_idempotency_requests
  DROP CONSTRAINT api_idempotency_requests_endpoint_check;
ALTER TABLE api_idempotency_requests
  ADD CONSTRAINT api_idempotency_requests_endpoint_check
  CHECK (endpoint IN (
    'chat.completions',
    'responses',
    'embeddings',
    'audio.transcriptions',
    'audio.translations',
    'audio.speech',
    'images.generations',
    'images.edits'
  ));
