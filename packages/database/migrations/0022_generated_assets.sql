-- Immutable generated media history. Binary bytes remain in the existing immutable attachment/object
-- layer; these rows record generation ownership, billing lineage, output order, and edit inputs.
ALTER TABLE attachments ADD CONSTRAINT attachments_owner_id_id_uq UNIQUE(owner_id,id);
ALTER TABLE usage_runs ADD CONSTRAINT usage_runs_user_id_id_uq UNIQUE(user_id,id);

CREATE TABLE generated_object_staging (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  usage_run_id text NOT NULL,
  ordinal smallint NOT NULL,
  object_key text NOT NULL UNIQUE,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  attachment_id uuid,
  state text NOT NULL DEFAULT 'pending',
  cleanup_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT generated_object_staging_usage_owner_fk FOREIGN KEY(owner_id,usage_run_id)
    REFERENCES usage_runs(user_id,id) ON DELETE RESTRICT,
  CONSTRAINT generated_object_staging_attachment_owner_fk FOREIGN KEY(owner_id,attachment_id)
    REFERENCES attachments(owner_id,id) ON DELETE RESTRICT,
  CONSTRAINT generated_object_staging_run_ordinal_uq UNIQUE(usage_run_id,ordinal),
  CONSTRAINT generated_object_staging_ordinal_check CHECK(ordinal BETWEEN 0 AND 9),
  CONSTRAINT generated_object_staging_key_check CHECK(
    char_length(object_key) BETWEEN 1 AND 1024 AND left(object_key,1) <> '/'),
  CONSTRAINT generated_object_staging_mime_check CHECK(
    char_length(mime_type) BETWEEN 3 AND 255 AND mime_type ~ '^[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+$'),
  CONSTRAINT generated_object_staging_size_check CHECK(size_bytes BETWEEN 1 AND 26214400),
  CONSTRAINT generated_object_staging_sha_check CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT generated_object_staging_state_check CHECK(state IN (
    'pending','stored','attached','finalized','cleanup_pending','cleaning','cleaned')),
  CONSTRAINT generated_object_staging_cleanup_error_check CHECK(
    cleanup_error IS NULL OR char_length(cleanup_error) <= 1000)
);
CREATE INDEX generated_object_staging_cleanup_idx
  ON generated_object_staging(state,updated_at,id)
  WHERE state IN ('cleanup_pending','cleaning');

CREATE TABLE generated_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  usage_run_id text NOT NULL,
  provider_model_id uuid NOT NULL REFERENCES provider_models(id) ON DELETE RESTRICT,
  public_model_id text NOT NULL,
  upstream_model_id text NOT NULL,
  provider_slug text NOT NULL,
  pricing_version_id uuid NOT NULL REFERENCES model_price_versions(id) ON DELETE RESTRICT,
  pricing_input_micros_per_million bigint NOT NULL,
  pricing_cached_input_micros_per_million bigint NOT NULL,
  pricing_reasoning_micros_per_million bigint NOT NULL,
  pricing_output_micros_per_million bigint NOT NULL,
  pricing_fixed_call_micros bigint NOT NULL,
  pricing_source text NOT NULL,
  attachment_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  operation text NOT NULL,
  prompt text NOT NULL,
  provider_created_at bigint NOT NULL,
  ordinal smallint NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  revised_prompt text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT generated_assets_usage_owner_fk FOREIGN KEY(owner_id,usage_run_id)
    REFERENCES usage_runs(user_id,id) ON DELETE RESTRICT,
  CONSTRAINT generated_assets_attachment_owner_fk FOREIGN KEY(owner_id,attachment_id)
    REFERENCES attachments(owner_id,id) ON DELETE RESTRICT,
  CONSTRAINT generated_assets_idempotency_uq UNIQUE(owner_id,idempotency_key,ordinal),
  CONSTRAINT generated_assets_run_ordinal_uq UNIQUE(usage_run_id,ordinal),
  CONSTRAINT generated_assets_idempotency_check CHECK(char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT generated_assets_request_hash_check CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT generated_assets_public_model_check CHECK(
    char_length(public_model_id) BETWEEN 3 AND 255 AND position('/' in public_model_id) > 1),
  CONSTRAINT generated_assets_upstream_model_check CHECK(char_length(upstream_model_id) BETWEEN 1 AND 255),
  CONSTRAINT generated_assets_provider_slug_check CHECK(provider_slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  CONSTRAINT generated_assets_pricing_check CHECK(
    pricing_input_micros_per_million BETWEEN 0 AND 9007199254740991 AND
    pricing_cached_input_micros_per_million BETWEEN 0 AND 9007199254740991 AND
    pricing_reasoning_micros_per_million BETWEEN 0 AND 9007199254740991 AND
    pricing_output_micros_per_million BETWEEN 0 AND 9007199254740991 AND
    pricing_fixed_call_micros BETWEEN 0 AND 9007199254740991 AND
    char_length(pricing_source) BETWEEN 1 AND 120),
  CONSTRAINT generated_assets_operation_check CHECK(operation IN ('generation','edit')),
  CONSTRAINT generated_assets_prompt_check CHECK(char_length(prompt) BETWEEN 1 AND 32000),
  CONSTRAINT generated_assets_provider_created_check CHECK(
    provider_created_at BETWEEN 0 AND 9007199254740991),
  CONSTRAINT generated_assets_ordinal_check CHECK(ordinal BETWEEN 0 AND 9),
  CONSTRAINT generated_assets_dimensions_check CHECK(width BETWEEN 1 AND 65535 AND height BETWEEN 1 AND 65535),
  CONSTRAINT generated_assets_revised_prompt_check CHECK(revised_prompt IS NULL OR char_length(revised_prompt) <= 32000)
);
CREATE UNIQUE INDEX generated_assets_owner_id_uq ON generated_assets(owner_id,id);
CREATE INDEX generated_assets_owner_created_idx ON generated_assets(owner_id,created_at DESC,id DESC);
CREATE INDEX generated_assets_usage_idx ON generated_assets(usage_run_id,ordinal);

CREATE TABLE generated_asset_inputs (
  generated_asset_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  attachment_id uuid NOT NULL,
  role text NOT NULL,
  ordinal smallint NOT NULL,
  PRIMARY KEY(generated_asset_id,role,ordinal),
  CONSTRAINT generated_asset_inputs_asset_owner_fk FOREIGN KEY(owner_id,generated_asset_id)
    REFERENCES generated_assets(owner_id,id) ON DELETE CASCADE,
  CONSTRAINT generated_asset_inputs_attachment_owner_fk FOREIGN KEY(owner_id,attachment_id)
    REFERENCES attachments(owner_id,id) ON DELETE RESTRICT,
  CONSTRAINT generated_asset_inputs_role_check CHECK(role IN ('source','mask','reference')),
  CONSTRAINT generated_asset_inputs_ordinal_check CHECK(ordinal BETWEEN 0 AND 9)
);
CREATE INDEX generated_asset_inputs_attachment_idx ON generated_asset_inputs(attachment_id);

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
    'images.generations'
  ));
