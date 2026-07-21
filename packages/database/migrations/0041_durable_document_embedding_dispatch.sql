-- A provider call cannot be made exactly-once unless the upstream accepts an idempotency key.
-- This ledger therefore makes dispatch at-most-once: only pre_dispatch may cross the network.
-- A response is durable before accounting/publishing, so every later crash is recoverable.
CREATE TABLE document_embedding_batches (
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  batch_ordinal integer NOT NULL CHECK(batch_ordinal >= 0),
  dispatch_epoch integer NOT NULL DEFAULT 0 CHECK(dispatch_epoch >= 0),
  -- Preparation must commit before credit reservation so a crash can resume safely. The usage
  -- row therefore cannot be an immediate FK; once present it is validated by the coordinator.
  usage_run_id text NOT NULL UNIQUE,
  request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
  item_count integer NOT NULL CHECK(item_count BETWEEN 1 AND 256),
  batch_size integer NOT NULL CHECK(batch_size BETWEEN 1 AND 256),
  maximum_input_tokens integer NOT NULL CHECK(maximum_input_tokens >= 0),
  phase text NOT NULL DEFAULT 'pre_dispatch'
    CHECK(phase IN ('pre_dispatch','dispatched','succeeded','committed')),
  retry_safe boolean NOT NULL DEFAULT false,
  dispatch_claim_token text,
  provider_response jsonb,
  provider_response_sha256 text CHECK(
    provider_response_sha256 IS NULL OR provider_response_sha256 ~ '^[0-9a-f]{64}$'
  ),
  input_tokens integer CHECK(input_tokens IS NULL OR input_tokens >= 0),
  latency_ms integer CHECK(latency_ms IS NULL OR latency_ms >= 0),
  dispatched_at timestamptz,
  responded_at timestamptz,
  committed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id,batch_ordinal),
  CHECK(
    (batch_ordinal % batch_size = 0 AND item_count <= batch_size)
  ),
  CHECK(
    (phase='pre_dispatch' AND retry_safe=false AND dispatch_claim_token IS NULL
      AND dispatched_at IS NULL AND provider_response IS NULL
      AND provider_response_sha256 IS NULL
      AND input_tokens IS NULL AND latency_ms IS NULL AND responded_at IS NULL
      AND committed_at IS NULL)
    OR
    (phase='dispatched' AND dispatch_claim_token IS NOT NULL
      AND dispatched_at IS NOT NULL AND provider_response IS NULL
      AND provider_response_sha256 IS NULL
      AND input_tokens IS NULL AND latency_ms IS NULL AND responded_at IS NULL
      AND committed_at IS NULL)
    OR
    (phase='succeeded' AND retry_safe=false AND dispatch_claim_token IS NOT NULL
      AND dispatched_at IS NOT NULL AND provider_response IS NOT NULL
      AND provider_response_sha256 IS NOT NULL
      AND input_tokens IS NOT NULL AND latency_ms IS NOT NULL AND responded_at IS NOT NULL
      AND committed_at IS NULL)
    OR
    (phase='committed' AND retry_safe=false AND dispatch_claim_token IS NOT NULL
      AND dispatched_at IS NOT NULL AND provider_response IS NULL
      AND provider_response_sha256 IS NOT NULL
      AND input_tokens IS NOT NULL AND latency_ms IS NOT NULL AND responded_at IS NOT NULL
      AND committed_at IS NOT NULL)
  )
);
CREATE INDEX document_embedding_batches_active_usage_idx
  ON document_embedding_batches(usage_run_id,phase)
  WHERE phase IN ('pre_dispatch','dispatched','succeeded');

CREATE TRIGGER dg_chat_restore_maintenance_fence
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON document_embedding_batches
  FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_restore_maintenance();
