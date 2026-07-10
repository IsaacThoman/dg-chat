ALTER TABLE attachments
  ADD COLUMN inspection_error text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN deleted_at timestamptz;

ALTER TABLE attachments DROP CONSTRAINT attachments_owner_id_sha256_key;

ALTER TABLE attachments ADD CONSTRAINT attachments_state_check
  CHECK (state IN ('pending','inspecting','ready','quarantined','failed','deleted'));

CREATE UNIQUE INDEX attachments_owner_active_hash_uq
  ON attachments(owner_id,sha256) WHERE deleted_at IS NULL;

ALTER TABLE jobs ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX jobs_idempotency_key_uq ON jobs(idempotency_key);
