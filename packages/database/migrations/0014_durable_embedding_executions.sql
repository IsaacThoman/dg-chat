CREATE TABLE document_embedding_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  attachment_id uuid NOT NULL REFERENCES attachments(id) ON DELETE RESTRICT,
  chunk_set_digest text NOT NULL CHECK (chunk_set_digest ~ '^[0-9a-f]{64}$'),
  model_id text NOT NULL CHECK (char_length(model_id) BETWEEN 1 AND 255),
  config_version text NOT NULL CHECK (config_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  usage_run_id text NOT NULL UNIQUE REFERENCES usage_runs(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','result_ready','completed','failed')),
  run_lease_token uuid,
  job_claim_token text,
  plan_snapshot jsonb NOT NULL CHECK (jsonb_typeof(plan_snapshot)='object'),
  result_cost_micros bigint CHECK (result_cost_micros BETWEEN 0 AND 9007199254740991),
  result_provider_cost_micros bigint CHECK (result_provider_cost_micros BETWEEN 0 AND 9007199254740991),
  result_input_tokens integer CHECK (result_input_tokens >= 0),
  result_latency_ms integer CHECK (result_latency_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(attachment_id,chunk_set_digest,model_id,config_version),
  CHECK ((status IN ('result_ready','completed') AND result_cost_micros IS NOT NULL
    AND result_provider_cost_micros IS NOT NULL AND result_input_tokens IS NOT NULL
    AND result_latency_ms IS NOT NULL)
    OR (status NOT IN ('result_ready','completed') AND result_cost_micros IS NULL
      AND result_provider_cost_micros IS NULL AND result_input_tokens IS NULL
      AND result_latency_ms IS NULL)),
  CHECK ((status IN ('completed','failed') AND completed_at IS NOT NULL) OR
    (status NOT IN ('completed','failed') AND completed_at IS NULL))
);
CREATE INDEX document_embedding_execution_owner_idx
  ON document_embedding_executions(owner_id,created_at);

CREATE TABLE document_embedding_execution_chunks (
  execution_id uuid NOT NULL REFERENCES document_embedding_executions(id) ON DELETE CASCADE,
  chunk_id uuid NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY(execution_id,chunk_id),
  UNIQUE(execution_id,ordinal)
);

CREATE TABLE document_embedding_results (
  execution_id uuid NOT NULL REFERENCES document_embedding_executions(id) ON DELETE CASCADE,
  chunk_id uuid NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  embedding vector(1536) NOT NULL,
  PRIMARY KEY(execution_id,chunk_id)
);
