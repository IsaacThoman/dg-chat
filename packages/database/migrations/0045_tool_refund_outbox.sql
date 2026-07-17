ALTER TABLE tool_executions DROP CONSTRAINT tool_executions_status_check;
ALTER TABLE tool_executions ADD CONSTRAINT tool_executions_status_check CHECK (
  status IN ('pending_approval', 'queued_pending_reservation', 'queued', 'running',
    'failed_pending_refund', 'cancelled_pending_refund', 'succeeded_pending_settlement',
    'succeeded', 'failed', 'cancelled')
);

ALTER TABLE tool_executions DROP CONSTRAINT IF EXISTS tool_executions_check1;

-- Every durable reservation names the subsystem that owns crash recovery. Provider/model strings
-- are display/configuration data and must never be used as an ownership discriminator.
ALTER TABLE usage_runs ADD COLUMN recovery_owner text;
CREATE TEMP TABLE usage_recovery_classification ON COMMIT DROP AS
WITH recovery_links AS (
  SELECT usage.id,
    EXISTS (
      SELECT 1 FROM tool_executions AS execution
      WHERE usage.id='tool:' || execution.id::text
        AND usage.user_id=execution.owner_id AND usage.token_id IS NULL
    ) AS tool_link,
    EXISTS (
      SELECT 1 FROM api_idempotency_requests AS request
      WHERE request.usage_run_id=usage.id
    ) AS api_link,
    EXISTS (
      SELECT 1 FROM document_embedding_batches AS batch
      WHERE batch.usage_run_id=usage.id
    ) AS document_link
  FROM usage_runs AS usage
)
SELECT *,tool_link::int + api_link::int + document_link::int AS owner_count
FROM recovery_links;

UPDATE usage_runs AS usage SET recovery_owner=CASE
  WHEN classified.owner_count=1 AND classified.tool_link THEN 'tool'
  WHEN classified.owner_count=1 AND classified.api_link THEN 'api_replay'
  WHEN classified.owner_count=1 AND classified.document_link THEN 'document_embedding'
  -- Ambiguous relationships must not be resolved by precedence. Their active controls are
  -- terminalized below, leaving the conflict closed for explicit operator reconciliation.
  ELSE 'provider'
END
FROM usage_recovery_classification AS classified WHERE usage.id=classified.id;

-- An ambiguous API replay must not retain a live lease. Preserve its replay identity but turn it
-- into a categorical terminal response so restart recovery cannot settle the same run.
UPDATE api_idempotency_requests AS request SET state='failed',lease_token=NULL,
  lease_expires_at=NULL,response_status=500,response_headers='{"content-type":"application/json"}',
  response_body='{"error":{"message":"Ambiguous recovery ownership","type":"server_error","code":"recovery_owner_ambiguous"}}',
  response_body_encoding='utf8',failure_started_stream=false,
  completed_at=COALESCE(completed_at,now()),updated_at=now()
FROM usage_recovery_classification AS classified
WHERE request.usage_run_id=classified.id AND classified.owner_count>1
  AND request.state='in_progress';

-- The document-batch state machine has no failed phase. Fail its owning job first, then remove
-- only active ambiguous dispatch controls. Committed history remains intact, while queued/running
-- jobs cannot recreate or dispatch the conflicted batch automatically.
UPDATE jobs AS job SET status='failed',
  last_error='Ambiguous usage recovery ownership; operator reconciliation required',
  completed_at=COALESCE(completed_at,now()),locked_at=NULL,locked_by=NULL
FROM document_embedding_batches AS batch
JOIN usage_recovery_classification AS classified ON classified.id=batch.usage_run_id
WHERE job.id=batch.job_id AND classified.owner_count>1
  AND batch.phase IN ('pre_dispatch','dispatched','succeeded')
  AND job.status IN ('queued','running');
DELETE FROM document_embedding_batches AS batch
USING usage_recovery_classification AS classified
WHERE batch.usage_run_id=classified.id AND classified.owner_count>1
  AND batch.phase IN ('pre_dispatch','dispatched','succeeded');

-- Tool reservations do not ordinarily carry provider leases. Once every competing active control
-- is terminal, hand an outstanding ambiguous debit to the conservative provider lease reaper. A
-- terminal API replay may delay this until its normal retention pruning, but it cannot execute or
-- settle the run while retained.
UPDATE usage_runs AS usage SET run_lease_token=COALESCE(run_lease_token,gen_random_uuid()),
  run_lease_expires_at=LEAST(COALESCE(run_lease_expires_at,now()),now()),
  generation_lease_token=NULL,generation_lease_expires_at=NULL
FROM usage_recovery_classification AS classified
WHERE usage.id=classified.id AND classified.owner_count>1 AND usage.status='reserved';
ALTER TABLE usage_runs ALTER COLUMN recovery_owner SET NOT NULL;
ALTER TABLE usage_runs ADD CONSTRAINT usage_runs_recovery_owner_check CHECK (
  recovery_owner IN ('provider','api_replay','document_embedding','tool')
);

-- Billing configuration is mutable deployment state. Capture the exact approval-time terms on the
-- durable execution so a restart can never reserve or settle at a newly configured price.
ALTER TABLE tool_executions ADD COLUMN billing_snapshot jsonb;

-- Stage exact accounting evidence once so every repair below makes the same classification. A
-- legacy run is owned by a tool only when the relationship, account, null token, recovery owner,
-- positive safe reserve, and debit ledger all agree. Provider/model identity is additionally
-- required before work may dispatch or a successful result may settle.
CREATE TEMP TABLE tool_accounting_repair ON COMMIT DROP AS
SELECT execution.id AS execution_id, usage.id AS usage_run_id, usage.status AS usage_status,
  usage.reserved_micros, usage.provider, usage.model,
  (
    usage.id IS NOT NULL AND usage.user_id=execution.owner_id AND usage.token_id IS NULL
    AND usage.recovery_owner='tool' AND usage.status='reserved'
    AND usage.reserved_micros BETWEEN 1 AND 9007199254740991
    AND char_length(usage.provider) BETWEEN 1 AND 255
    AND char_length(usage.model) BETWEEN 1 AND 255
    AND ledger.reserve_count=1 AND ledger.reserve_total=-usage.reserved_micros
    AND ledger.terminal_count=0 AND ledger.owner_mismatch_count=0
  ) AS owned_reserved,
  (
    usage.id IS NOT NULL AND usage.user_id=execution.owner_id AND usage.token_id IS NULL
    AND usage.recovery_owner='tool' AND usage.status='reserved'
    AND usage.reserved_micros BETWEEN 1 AND 9007199254740991
    AND usage.provider='tool' AND usage.model='tool/' || execution.tool_id
    AND ledger.reserve_count=1 AND ledger.reserve_total=-usage.reserved_micros
    AND ledger.terminal_count=0 AND ledger.owner_mismatch_count=0
  ) AS canonical_reserved
FROM tool_executions AS execution
LEFT JOIN usage_runs AS usage ON usage.id='tool:' || execution.id::text
LEFT JOIN LATERAL (
  SELECT count(*) FILTER (WHERE kind='reserve')::int AS reserve_count,
    COALESCE(sum(amount_micros) FILTER (WHERE kind='reserve'),0)::bigint AS reserve_total,
    count(*) FILTER (WHERE kind IN ('settle','refund'))::int AS terminal_count,
    count(*) FILTER (WHERE user_id IS DISTINCT FROM execution.owner_id)::int
      AS owner_mismatch_count
  FROM ledger_entries WHERE usage_run_id=usage.id
) AS ledger ON true;

UPDATE tool_executions AS execution SET billing_snapshot=jsonb_build_object(
  'reservedMicros', repair.reserved_micros,
  'provider', repair.provider,
  'model', repair.model
)
FROM tool_accounting_repair AS repair
WHERE execution.id=repair.execution_id AND repair.owned_reserved;

-- Reserved debits attached to terminal failures/cancellations are reopened into the refund outbox.
UPDATE tool_executions AS execution SET
  status=CASE WHEN execution.status='failed' THEN 'failed_pending_refund'
    ELSE 'cancelled_pending_refund' END,
  result=NULL,
  error=CASE WHEN execution.status='failed' THEN execution.error ELSE NULL END,
  cancellation_requested_at=CASE WHEN execution.status='failed' THEN cancellation_requested_at
    ELSE COALESCE(cancellation_requested_at,now()) END
FROM tool_accounting_repair AS repair
WHERE execution.id=repair.execution_id AND repair.owned_reserved
  AND execution.status IN ('pending_approval','failed','cancelled');

-- A delivered result with a canonical outstanding debit must be settled after restart. A result
-- whose identity is not canonical cannot safely be billed, so it is instead cancelled/refunded.
UPDATE tool_executions AS execution SET status='succeeded_pending_settlement'
FROM tool_accounting_repair AS repair
WHERE execution.id=repair.execution_id AND repair.canonical_reserved
  AND execution.status='succeeded';
UPDATE tool_executions AS execution SET status='cancelled_pending_refund',result=NULL,error=NULL,
  cancellation_requested_at=COALESCE(cancellation_requested_at,now())
FROM tool_accounting_repair AS repair
WHERE execution.id=repair.execution_id AND repair.owned_reserved
  AND NOT repair.canonical_reserved AND execution.status='succeeded';

-- Any non-canonical active debit is refund-only; it must never reach an adapter. Active rows with
-- no trustworthy debit evidence fail terminally and cannot synthesize accounting from new config.
UPDATE tool_executions AS execution SET status='cancelled_pending_refund',result=NULL,error=NULL,
  cancellation_requested_at=COALESCE(cancellation_requested_at,now())
FROM tool_accounting_repair AS repair
WHERE execution.id=repair.execution_id AND repair.owned_reserved
  AND NOT repair.canonical_reserved
  AND execution.status IN ('queued_pending_reservation','queued','running',
    'failed_pending_refund','cancelled_pending_refund','succeeded_pending_settlement');
UPDATE tool_executions AS execution SET status='failed',result=NULL,
  error=jsonb_build_object('code','tool_execution_failed','message','Tool execution failed')
FROM tool_accounting_repair AS repair
WHERE execution.id=repair.execution_id AND NOT repair.owned_reserved
  AND execution.status IN ('queued_pending_reservation','queued','running',
    'failed_pending_refund','cancelled_pending_refund','succeeded_pending_settlement');

ALTER TABLE tool_executions ADD CONSTRAINT tool_executions_billing_snapshot_check CHECK (
  billing_snapshot IS NULL OR CASE
    WHEN jsonb_typeof(billing_snapshot)='object'
      AND jsonb_typeof(billing_snapshot->'reservedMicros')='number'
      AND (billing_snapshot->>'reservedMicros') ~ '^[1-9][0-9]{0,15}$'
      AND jsonb_typeof(billing_snapshot->'provider')='string'
      AND char_length(billing_snapshot->>'provider') BETWEEN 1 AND 255
      AND jsonb_typeof(billing_snapshot->'model')='string'
      AND char_length(billing_snapshot->>'model') BETWEEN 1 AND 255
    THEN (billing_snapshot->>'reservedMicros')::bigint <= 9007199254740991
      AND billing_snapshot=jsonb_build_object(
        'reservedMicros',(billing_snapshot->>'reservedMicros')::bigint,
        'provider',billing_snapshot->>'provider',
        'model',billing_snapshot->>'model'
      )
    ELSE false
  END
);

ALTER TABLE tool_executions ADD CONSTRAINT tool_executions_active_billing_check CHECK (
  status NOT IN ('queued_pending_reservation','queued','running','failed_pending_refund',
    'cancelled_pending_refund','succeeded_pending_settlement') OR billing_snapshot IS NOT NULL
);

CREATE OR REPLACE FUNCTION prevent_tool_billing_snapshot_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.billing_snapshot IS NOT NULL AND NEW.billing_snapshot IS DISTINCT FROM OLD.billing_snapshot
  THEN
    RAISE EXCEPTION 'tool billing snapshot is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tool_executions_billing_snapshot_immutable
BEFORE UPDATE OF billing_snapshot ON tool_executions
FOR EACH ROW EXECUTE FUNCTION prevent_tool_billing_snapshot_change();

-- Releases before 0045 could persist adapter exception text. Rewrite every historical payload to
-- a closed set before installing the stronger constraint; usage_runs is independently scrubbed
-- because accounting views and exports may outlive the tool row's public presentation.
WITH categorized AS (
  SELECT id,
    CASE
      WHEN error->>'code' IN ('invalid_request','tool_invalid_request')
        THEN 'tool_invalid_request'
      WHEN error->>'code' IN ('policy_denied','tool_not_allowed','tool_policy_denied')
        THEN 'tool_policy_denied'
      WHEN error->>'code' IN ('not_configured','tool_unavailable')
        THEN 'tool_unavailable'
      WHEN error->>'code' IN ('request_timeout','timeout','tool_timeout')
        THEN 'tool_timeout'
      WHEN error->>'code' IN (
        'request_failed','upstream_unavailable','tool_upstream_unavailable'
      ) THEN 'tool_upstream_unavailable'
      WHEN error->>'code' IN ('invalid_response','response_too_large','tool_invalid_response')
        THEN 'tool_invalid_response'
      ELSE 'tool_execution_failed'
    END AS code
  FROM tool_executions WHERE error IS NOT NULL
)
UPDATE tool_executions AS execution
SET error=jsonb_build_object(
  'code', categorized.code,
  'message', CASE categorized.code
    WHEN 'tool_invalid_request' THEN 'Tool request was rejected'
    WHEN 'tool_policy_denied' THEN 'Tool execution was blocked by policy'
    WHEN 'tool_unavailable' THEN 'Tool service is not configured'
    WHEN 'tool_timeout' THEN 'Tool service timed out'
    WHEN 'tool_upstream_unavailable' THEN 'Tool service is unavailable'
    WHEN 'tool_invalid_response' THEN 'Tool service returned an invalid response'
    ELSE 'Tool execution failed'
  END
)
FROM categorized WHERE execution.id=categorized.id;

UPDATE usage_runs AS usage
SET error=CASE
  WHEN execution.status IN ('cancelled_pending_refund','cancelled')
    THEN 'Tool execution was cancelled'
  ELSE COALESCE(execution.error->>'message','Tool execution failed')
END
FROM tool_executions AS execution
WHERE usage.id='tool:' || execution.id::text AND usage.error IS NOT NULL;

ALTER TABLE tool_executions ADD CONSTRAINT tool_executions_error_status_check CHECK (
  error IS NULL OR (
    status IN ('failed_pending_refund', 'failed')
    AND jsonb_typeof(error)='object'
    AND error->>'code' IN (
      'tool_invalid_request','tool_policy_denied','tool_unavailable','tool_timeout',
      'tool_upstream_unavailable','tool_invalid_response','tool_execution_failed'
    )
    AND error=jsonb_build_object(
      'code',error->>'code',
      'message',CASE error->>'code'
        WHEN 'tool_invalid_request' THEN 'Tool request was rejected'
        WHEN 'tool_policy_denied' THEN 'Tool execution was blocked by policy'
        WHEN 'tool_unavailable' THEN 'Tool service is not configured'
        WHEN 'tool_timeout' THEN 'Tool service timed out'
        WHEN 'tool_upstream_unavailable' THEN 'Tool service is unavailable'
        WHEN 'tool_invalid_response' THEN 'Tool service returned an invalid response'
        ELSE 'Tool execution failed'
      END
    )
  )
);

CREATE INDEX tool_executions_refund_pending_idx ON tool_executions(updated_at, id)
  WHERE status IN ('failed_pending_refund', 'cancelled_pending_refund');
