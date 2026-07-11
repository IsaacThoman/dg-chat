CREATE TABLE embedding_provider_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usage_run_id text NOT NULL UNIQUE REFERENCES usage_runs(id) ON DELETE RESTRICT,
  parent_usage_run_id text REFERENCES usage_runs(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN ('document','query')),
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 255),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 200),
  upstream_model text NOT NULL CHECK (char_length(upstream_model) BETWEEN 1 AND 200),
  item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 256),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','cancelled')),
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  cost_micros bigint NOT NULL DEFAULT 0 CHECK (cost_micros BETWEEN 0 AND 9007199254740991),
  token_source text NOT NULL DEFAULT 'none' CHECK (token_source IN ('provider','estimated','none')),
  cost_source text NOT NULL DEFAULT 'none' CHECK (cost_source IN ('calculated','none')),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error text CHECK (error IS NULL OR char_length(error) <= 1000),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((status='running' AND completed_at IS NULL) OR (status<>'running' AND completed_at IS NOT NULL))
);
CREATE INDEX embedding_provider_attempts_parent_idx
  ON embedding_provider_attempts(parent_usage_run_id, started_at DESC);
CREATE INDEX embedding_provider_attempts_purpose_started_idx
  ON embedding_provider_attempts(purpose, started_at DESC);
