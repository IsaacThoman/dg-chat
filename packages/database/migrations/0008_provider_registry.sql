CREATE TABLE providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  display_name text NOT NULL,
  base_url text NOT NULL,
  protocol text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  credential_envelope jsonb,
  credential_updated_at timestamptz,
  health_status text NOT NULL DEFAULT 'unknown',
  health_checked_at timestamptz,
  health_latency_ms integer,
  health_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT providers_slug_uq UNIQUE (slug),
  CONSTRAINT providers_slug_check CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  CONSTRAINT providers_display_name_check CHECK (char_length(display_name) BETWEEN 1 AND 120),
  CONSTRAINT providers_base_url_check CHECK (
    char_length(base_url) BETWEEN 1 AND 2048 AND
    base_url ~ '^https://[^/?#@]+(?:/[^?#@]*)?$'
  ),
  CONSTRAINT providers_protocol_check CHECK (protocol IN ('chat_completions','responses')),
  CONSTRAINT providers_version_check CHECK (version >= 1),
  CONSTRAINT providers_credential_check CHECK (
    (credential_envelope IS NULL AND credential_updated_at IS NULL) OR
    (credential_envelope IS NOT NULL AND credential_updated_at IS NOT NULL AND
      jsonb_typeof(credential_envelope) = 'object' AND
      credential_envelope->>'version' = '1' AND
      credential_envelope->>'algorithm' = 'AES-256-GCM' AND
      credential_envelope->>'keyId' ~ '^[A-Za-z0-9._-]{1,64}$' AND
      credential_envelope->>'credentialVersion' ~ '^[1-9][0-9]{0,15}$' AND
      jsonb_typeof(credential_envelope->'wrappedKeyNonce') = 'string' AND
      jsonb_typeof(credential_envelope->'wrappedKey') = 'string' AND
      jsonb_typeof(credential_envelope->'contentNonce') = 'string' AND
      jsonb_typeof(credential_envelope->'ciphertext') = 'string')
  ),
  CONSTRAINT providers_health_status_check CHECK (
    health_status IN ('unknown','healthy','unhealthy','disabled')
  ),
  CONSTRAINT providers_health_latency_check CHECK (health_latency_ms IS NULL OR health_latency_ms >= 0),
  CONSTRAINT providers_health_error_check CHECK (health_error IS NULL OR char_length(health_error) <= 1000)
);

CREATE INDEX providers_enabled_display_idx ON providers(enabled,display_name,id);
CREATE INDEX providers_health_idx ON providers(health_status,health_checked_at DESC);

CREATE TABLE provider_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  public_model_id text NOT NULL,
  upstream_model_id text NOT NULL,
  display_name text NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  context_window integer NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  custom_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_models_public_model_id_uq UNIQUE (public_model_id),
  CONSTRAINT provider_models_public_id_check CHECK (
    char_length(public_model_id) BETWEEN 3 AND 255 AND position('/' in public_model_id) > 1
  ),
  CONSTRAINT provider_models_upstream_id_check CHECK (char_length(upstream_model_id) BETWEEN 1 AND 255),
  CONSTRAINT provider_models_display_name_check CHECK (char_length(display_name) BETWEEN 1 AND 120),
  CONSTRAINT provider_models_capabilities_check CHECK (jsonb_typeof(capabilities) = 'array'),
  CONSTRAINT provider_models_context_window_check CHECK (context_window > 0),
  CONSTRAINT provider_models_version_check CHECK (version >= 1),
  CONSTRAINT provider_models_custom_params_check CHECK (jsonb_typeof(custom_params) = 'object')
);

CREATE INDEX provider_models_provider_enabled_idx
  ON provider_models(provider_id,enabled,display_name,id);
CREATE INDEX provider_models_enabled_public_idx
  ON provider_models(enabled,public_model_id);

CREATE TABLE model_price_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_model_id uuid NOT NULL REFERENCES provider_models(id) ON DELETE RESTRICT,
  effective_at timestamptz NOT NULL,
  input_micros_per_million bigint NOT NULL,
  cached_input_micros_per_million bigint NOT NULL,
  reasoning_micros_per_million bigint NOT NULL,
  output_micros_per_million bigint NOT NULL,
  fixed_call_micros bigint NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_price_versions_model_effective_uq UNIQUE (provider_model_id,effective_at),
  CONSTRAINT model_price_versions_amounts_check CHECK (
    input_micros_per_million >= 0 AND cached_input_micros_per_million >= 0 AND
    reasoning_micros_per_million >= 0 AND output_micros_per_million >= 0 AND
    fixed_call_micros >= 0 AND
    input_micros_per_million <= 9007199254740991 AND
    cached_input_micros_per_million <= 9007199254740991 AND
    reasoning_micros_per_million <= 9007199254740991 AND
    output_micros_per_million <= 9007199254740991 AND
    fixed_call_micros <= 9007199254740991
  ),
  CONSTRAINT model_price_versions_source_check CHECK (char_length(source) BETWEEN 1 AND 120)
);

CREATE INDEX model_price_versions_effective_idx
  ON model_price_versions(provider_model_id,effective_at DESC,id DESC);

ALTER TABLE usage_runs
  ADD COLUMN pricing_version_id uuid REFERENCES model_price_versions(id) ON DELETE RESTRICT,
  ADD COLUMN pricing_input_micros_per_million bigint,
  ADD COLUMN pricing_cached_input_micros_per_million bigint,
  ADD COLUMN pricing_reasoning_micros_per_million bigint,
  ADD COLUMN pricing_output_micros_per_million bigint,
  ADD COLUMN pricing_fixed_call_micros bigint,
  ADD COLUMN pricing_source text,
  ADD CONSTRAINT usage_runs_pricing_snapshot_check CHECK (
    (pricing_version_id IS NULL AND
      pricing_input_micros_per_million IS NULL AND
      pricing_cached_input_micros_per_million IS NULL AND
      pricing_reasoning_micros_per_million IS NULL AND
      pricing_output_micros_per_million IS NULL AND
      pricing_fixed_call_micros IS NULL AND
      pricing_source IS NULL)
    OR
    (pricing_version_id IS NOT NULL AND
      pricing_input_micros_per_million IS NOT NULL AND
      pricing_cached_input_micros_per_million IS NOT NULL AND
      pricing_reasoning_micros_per_million IS NOT NULL AND
      pricing_output_micros_per_million IS NOT NULL AND
      pricing_fixed_call_micros IS NOT NULL AND
      pricing_source IS NOT NULL AND
      pricing_input_micros_per_million BETWEEN 0 AND 9007199254740991 AND
      pricing_cached_input_micros_per_million BETWEEN 0 AND 9007199254740991 AND
      pricing_reasoning_micros_per_million BETWEEN 0 AND 9007199254740991 AND
      pricing_output_micros_per_million BETWEEN 0 AND 9007199254740991 AND
      pricing_fixed_call_micros BETWEEN 0 AND 9007199254740991 AND
      char_length(pricing_source) BETWEEN 1 AND 120)
  ) NOT VALID;
