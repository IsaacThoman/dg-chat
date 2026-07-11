ALTER TABLE tool_executions DROP CONSTRAINT tool_executions_status_check;
ALTER TABLE tool_executions ADD CONSTRAINT tool_executions_status_check CHECK (
  status IN ('pending_approval', 'queued_pending_reservation', 'queued', 'running', 'succeeded_pending_settlement',
    'succeeded', 'failed', 'cancelled')
);
ALTER TABLE tool_executions ADD COLUMN claim_token uuid;
ALTER TABLE tool_executions ADD COLUMN claim_expires_at timestamptz;
ALTER TABLE tool_executions DROP CONSTRAINT tool_executions_check;
ALTER TABLE tool_executions ADD CONSTRAINT tool_executions_result_status_check CHECK (
  result IS NULL OR status IN ('succeeded_pending_settlement', 'succeeded')
);

CREATE TABLE message_tool_executions (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL REFERENCES tool_executions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(message_id, execution_id)
);

CREATE INDEX message_tool_executions_execution_idx ON message_tool_executions(execution_id);
