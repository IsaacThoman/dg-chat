ALTER TABLE usage_runs
  ADD COLUMN execution_epoch integer NOT NULL DEFAULT 0 CHECK (execution_epoch >= 0),
  ADD COLUMN execution_owner_lease_token uuid,
  ADD COLUMN run_lease_token uuid,
  ADD COLUMN run_lease_expires_at timestamptz,
  ADD COLUMN actual_provider_cost_micros bigint NOT NULL DEFAULT 0 CHECK (actual_provider_cost_micros BETWEEN 0 AND 9007199254740991),
  ADD COLUMN actual_provider_input_tokens bigint NOT NULL DEFAULT 0 CHECK (actual_provider_input_tokens BETWEEN 0 AND 9007199254740991),
  ADD COLUMN actual_provider_cached_input_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN actual_provider_reasoning_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN actual_provider_output_tokens bigint NOT NULL DEFAULT 0 CHECK (actual_provider_output_tokens BETWEEN 0 AND 9007199254740991),
  ADD CONSTRAINT usage_runs_actual_provider_token_check CHECK (
    actual_provider_cached_input_tokens BETWEEN 0 AND actual_provider_input_tokens AND
    actual_provider_reasoning_tokens BETWEEN 0 AND actual_provider_output_tokens
  );

CREATE TABLE provider_retry_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  enabled boolean NOT NULL DEFAULT true,
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 8),
  max_retries integer NOT NULL CHECK (max_retries BETWEEN 0 AND 3 AND max_retries < max_attempts),
  base_delay_ms integer NOT NULL CHECK (base_delay_ms BETWEEN 0 AND 60000),
  max_delay_ms integer NOT NULL CHECK (max_delay_ms BETWEEN base_delay_ms AND 300000),
  backoff_multiplier_bps integer NOT NULL CHECK (backoff_multiplier_bps BETWEEN 10000 AND 40000),
  jitter_bps integer NOT NULL CHECK (jitter_bps BETWEEN 0 AND 10000),
  first_token_timeout_ms integer NOT NULL CHECK (first_token_timeout_ms BETWEEN 250 AND 300000),
  idle_timeout_ms integer NOT NULL CHECK (idle_timeout_ms BETWEEN 250 AND 300000),
  total_timeout_ms integer NOT NULL CHECK (total_timeout_ms BETWEEN GREATEST(first_token_timeout_ms,idle_timeout_ms) AND 900000),
  retryable_statuses jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(retryable_statuses)='array' AND jsonb_array_length(retryable_statuses)<=7 AND retryable_statuses <@ '[408,425,429,500,502,503,504]'::jsonb),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_retry_policies_enabled_name_idx ON provider_retry_policies(enabled,name,id);

CREATE TABLE provider_model_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_model_id uuid NOT NULL UNIQUE REFERENCES provider_models(id) ON DELETE RESTRICT,
  retry_policy_id uuid REFERENCES provider_retry_policies(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_model_route_targets (
  route_id uuid NOT NULL REFERENCES provider_model_routes(id) ON DELETE CASCADE,
  target_model_id uuid NOT NULL REFERENCES provider_models(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
  PRIMARY KEY(route_id,ordinal),
  UNIQUE(route_id,target_model_id)
);
CREATE INDEX provider_model_route_targets_target_idx ON provider_model_route_targets(target_model_id);

CREATE TABLE provider_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usage_run_id text NOT NULL REFERENCES usage_runs(id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 16),
  execution_epoch integer NOT NULL CHECK (execution_epoch >= 1),
  target_ordinal integer NOT NULL CHECK (target_ordinal BETWEEN 0 AND 7),
  retry_number integer NOT NULL CHECK (retry_number BETWEEN 0 AND 3),
  reason text NOT NULL CHECK (reason IN ('primary','retry','fallback','circuit_skip','half_open')),
  breaker_before text CHECK (breaker_before IS NULL OR breaker_before IN ('closed','open','half_open','unavailable')),
  breaker_after text CHECK (breaker_after IS NULL OR breaker_after IN ('closed','open','half_open','unavailable')),
  retryable boolean NOT NULL DEFAULT false,
  provider_id uuid NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  provider_slug text NOT NULL CHECK (char_length(provider_slug) BETWEEN 1 AND 63),
  provider_version integer NOT NULL CHECK (provider_version >= 1),
  protocol text NOT NULL CHECK (protocol IN ('chat_completions','responses')),
  provider_model_id uuid NOT NULL REFERENCES provider_models(id) ON DELETE RESTRICT,
  public_model_id text NOT NULL CHECK (char_length(public_model_id) BETWEEN 3 AND 255),
  upstream_model_id text NOT NULL CHECK (char_length(upstream_model_id) BETWEEN 1 AND 255),
  model_version integer NOT NULL CHECK (model_version >= 1),
  pricing_version_id uuid NOT NULL REFERENCES model_price_versions(id) ON DELETE RESTRICT,
  pricing_input_micros_per_million bigint NOT NULL CHECK (pricing_input_micros_per_million BETWEEN 0 AND 9007199254740991),
  pricing_cached_input_micros_per_million bigint NOT NULL CHECK (pricing_cached_input_micros_per_million BETWEEN 0 AND 9007199254740991),
  pricing_reasoning_micros_per_million bigint NOT NULL CHECK (pricing_reasoning_micros_per_million BETWEEN 0 AND 9007199254740991),
  pricing_output_micros_per_million bigint NOT NULL CHECK (pricing_output_micros_per_million BETWEEN 0 AND 9007199254740991),
  pricing_fixed_call_micros bigint NOT NULL CHECK (pricing_fixed_call_micros BETWEEN 0 AND 9007199254740991),
  pricing_source text NOT NULL CHECK (char_length(pricing_source) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','cancelled','skipped')),
  phase text NOT NULL DEFAULT 'planning' CHECK (phase IN ('planning','connect','headers','first_token','streaming','complete')),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9][a-z0-9_.-]{0,119}$'),
  http_status integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  visible_output boolean NOT NULL DEFAULT false,
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  cached_input_tokens integer NOT NULL DEFAULT 0 CHECK (cached_input_tokens BETWEEN 0 AND input_tokens),
  reasoning_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0 AND reasoning_tokens BETWEEN 0 AND output_tokens),
  cost_micros bigint NOT NULL DEFAULT 0 CHECK (cost_micros BETWEEN 0 AND 9007199254740991),
  token_source text NOT NULL DEFAULT 'none' CHECK (token_source IN ('provider','estimated','none')),
  cost_source text NOT NULL DEFAULT 'none' CHECK (cost_source IN ('provider','calculated','none')),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  ttft_ms integer CHECK (ttft_ms IS NULL OR (latency_ms IS NOT NULL AND ttft_ms >= 0 AND ttft_ms <= latency_ms)),
  upstream_request_id text CHECK (upstream_request_id IS NULL OR upstream_request_id ~ '^[A-Za-z0-9._:-]{1,255}$'),
  tokens_per_second double precision CHECK (tokens_per_second IS NULL OR (tokens_per_second >= 0 AND tokens_per_second <= 1000000)),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(usage_run_id,attempt_number),
  CHECK ((status='running' AND completed_at IS NULL) OR (status<>'running' AND completed_at IS NOT NULL)),
  CHECK ((status='succeeded' AND phase='complete' AND error_code IS NULL AND (http_status IS NULL OR http_status BETWEEN 200 AND 299)) OR status='running' OR (status IN ('failed','cancelled','skipped') AND error_code IS NOT NULL)),
  CHECK (status<>'skipped' OR (NOT visible_output AND input_tokens=0 AND output_tokens=0 AND cost_micros=0 AND token_source='none' AND cost_source='none'))
);
CREATE INDEX provider_attempts_run_idx ON provider_attempts(usage_run_id,attempt_number);
