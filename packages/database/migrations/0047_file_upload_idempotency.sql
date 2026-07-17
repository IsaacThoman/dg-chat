ALTER TABLE api_idempotency_requests
  DROP CONSTRAINT api_idempotency_requests_endpoint_check;
ALTER TABLE api_idempotency_requests
  ADD CONSTRAINT api_idempotency_requests_endpoint_check
  CHECK (endpoint IN (
    'chat.completions',
    'responses',
    'embeddings',
    'audio.transcriptions',
    'audio.translations',
    'audio.speech',
    'images.generations',
    'images.edits',
    'files'
  ));

-- File records carry caller-visible metadata and are therefore not content-addressed records.
-- Multiple records may safely reference one immutable content-addressed object.
ALTER TABLE attachments DROP CONSTRAINT attachments_object_key_key;
DROP INDEX attachments_owner_active_hash_uq;
CREATE INDEX attachments_object_key_idx ON attachments(object_key);
CREATE INDEX attachments_owner_active_hash_idx
  ON attachments(owner_id,sha256) WHERE deleted_at IS NULL;

CREATE TABLE file_upload_staging (
  request_id uuid PRIMARY KEY REFERENCES api_idempotency_requests(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_key text NOT NULL,
  filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK(size_bytes>=0),
  sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),
  purpose text NOT NULL CHECK(purpose='assistants'),
  attachment_state text NOT NULL CHECK(attachment_state IN ('ready','quarantined')),
  inspection_error text,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','stored','finalized')),
  attachment_id uuid REFERENCES attachments(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX file_upload_staging_state_idx ON file_upload_staging(state,updated_at);
CREATE TRIGGER dg_chat_restore_maintenance_fence
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON file_upload_staging
  FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_restore_maintenance();
