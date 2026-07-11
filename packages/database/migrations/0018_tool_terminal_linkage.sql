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

CREATE FUNCTION link_message_tool_executions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_count integer;
DECLARE matched_count integer;
BEGIN
  IF NOT (NEW.metadata ? 'toolExecutionIds') THEN RETURN NEW; END IF;
  IF jsonb_typeof(NEW.metadata->'toolExecutionIds') <> 'array' THEN
    RAISE EXCEPTION 'tool execution linkage must be an array';
  END IF;
  expected_count := jsonb_array_length(NEW.metadata->'toolExecutionIds');
  SELECT count(*) INTO matched_count FROM tool_executions e
    JOIN conversations c ON c.id=NEW.conversation_id
    WHERE e.id IN (SELECT jsonb_array_elements_text(NEW.metadata->'toolExecutionIds')::uuid)
      AND e.owner_id=c.owner_id AND e.status='succeeded';
  IF matched_count <> expected_count THEN
    RAISE EXCEPTION 'tool execution linkage is invalid';
  END IF;
  INSERT INTO message_tool_executions(message_id,execution_id)
    SELECT NEW.id,jsonb_array_elements_text(NEW.metadata->'toolExecutionIds')::uuid;
  RETURN NEW;
END $$;

CREATE TRIGGER messages_link_tool_executions
  AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION link_message_tool_executions();
