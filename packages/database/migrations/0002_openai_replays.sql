CREATE TABLE api_idempotency_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL CHECK (endpoint IN ('chat.completions', 'responses')),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_hash text NOT NULL CHECK (char_length(request_hash) = 64),
  stream boolean NOT NULL,
  model text NOT NULL,
  state text NOT NULL CHECK (state IN ('in_progress', 'completed', 'failed')),
  lease_token uuid,
  lease_expires_at timestamptz,
  usage_run_id text NOT NULL UNIQUE REFERENCES usage_runs(id) DEFERRABLE INITIALLY DEFERRED,
  response_status integer CHECK (response_status BETWEEN 100 AND 599),
  response_headers jsonb NOT NULL DEFAULT '{}',
  response_body text,
  failure_started_stream boolean NOT NULL DEFAULT false,
  observed_input_tokens integer NOT NULL DEFAULT 0 CHECK (observed_input_tokens >= 0),
  observed_output_tokens integer NOT NULL DEFAULT 0 CHECK (observed_output_tokens >= 0),
  observed_cost_micros bigint NOT NULL DEFAULT 0 CHECK (observed_cost_micros >= 0),
  observed_latency_ms integer NOT NULL DEFAULT 0 CHECK (observed_latency_ms >= 0),
  retention_seconds integer NOT NULL DEFAULT 86400 CHECK (retention_seconds BETWEEN 60 AND 2592000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  UNIQUE (user_id, endpoint, idempotency_key),
  CHECK ((state = 'in_progress') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (state = 'in_progress' OR (completed_at IS NOT NULL AND response_status IS NOT NULL))
);

CREATE TABLE api_idempotency_events (
  request_id uuid NOT NULL REFERENCES api_idempotency_requests(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 0),
  frame text NOT NULL CHECK (octet_length(frame) <= 1048576),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, sequence)
);

CREATE INDEX api_idempotency_lease_idx
  ON api_idempotency_requests(state, lease_expires_at) WHERE state = 'in_progress';
CREATE INDEX api_idempotency_expiry_idx ON api_idempotency_requests(expires_at);
