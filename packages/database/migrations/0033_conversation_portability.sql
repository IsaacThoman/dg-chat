ALTER TYPE message_role ADD VALUE IF NOT EXISTS 'developer';

ALTER TABLE attachments ADD COLUMN width integer;
ALTER TABLE attachments ADD COLUMN height integer;
ALTER TABLE attachments ADD CONSTRAINT attachments_dimensions_check CHECK(
  (width IS NULL AND height IS NULL) OR
  (width BETWEEN 1 AND 100000 AND height BETWEEN 1 AND 100000)
);

ALTER TABLE message_attachments ADD COLUMN position integer DEFAULT 0;
WITH ranked AS (
  SELECT message_id,attachment_id,
    row_number() OVER(PARTITION BY message_id ORDER BY attachment_id)-1 AS position
  FROM message_attachments
)
UPDATE message_attachments ma SET position=ranked.position
FROM ranked WHERE ranked.message_id=ma.message_id AND ranked.attachment_id=ma.attachment_id;
ALTER TABLE message_attachments ALTER COLUMN position SET NOT NULL;
ALTER TABLE message_attachments ADD CONSTRAINT message_attachments_position_check
  CHECK(position >= 0);
ALTER TABLE message_attachments ADD CONSTRAINT message_attachments_message_position_uq
  UNIQUE(message_id,position);

CREATE TABLE conversation_portability_imports (
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,idempotency_key),
  CONSTRAINT conversation_portability_imports_key_check
    CHECK(char_length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT conversation_portability_imports_hash_check
    CHECK(payload_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX conversation_portability_imports_owner_created_idx
  ON conversation_portability_imports(owner_id,created_at DESC);

CREATE TRIGGER dg_chat_restore_maintenance_fence
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON conversation_portability_imports
  FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_restore_maintenance();

-- Trusted global maintenance cannot use the owner-leading lifecycle index.
CREATE INDEX conversations_temporary_expiry_global_idx
  ON conversations(temporary_expires_at,id) WHERE temporary=true;
