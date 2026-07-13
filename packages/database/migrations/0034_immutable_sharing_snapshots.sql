-- Revocable public shares materialize an immutable root-to-leaf path. Capability plaintext is
-- caller-held and is never persisted; only its SHA-256 digest is stored.
CREATE TABLE conversation_share_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  leaf_id uuid NOT NULL,
  conversation_version integer NOT NULL,
  title text NOT NULL,
  identity_visibility text NOT NULL,
  attachment_policy text NOT NULL,
  owner_name_snapshot text,
  public_snapshot jsonb NOT NULL,
  source_attachments jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_hash text NOT NULL,
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_share_snapshots_secret_uq UNIQUE(secret_hash),
  CONSTRAINT conversation_share_snapshots_owner_idempotency_uq
    UNIQUE(owner_id,idempotency_key),
  CONSTRAINT conversation_share_snapshots_conversation_owner_fk
    FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id) ON DELETE CASCADE,
  CONSTRAINT conversation_share_snapshots_version_check CHECK(version >= 1),
  CONSTRAINT conversation_share_snapshots_conversation_version_check
    CHECK(conversation_version >= 0),
  CONSTRAINT conversation_share_snapshots_title_check
    CHECK(char_length(title) BETWEEN 1 AND 500),
  CONSTRAINT conversation_share_snapshots_identity_check
    CHECK(identity_visibility IN ('owner','anonymous')),
  CONSTRAINT conversation_share_snapshots_attachment_policy_check
    CHECK(attachment_policy IN ('include','redact','selected')),
  CONSTRAINT conversation_share_snapshots_owner_name_check CHECK(
    (identity_visibility='owner' AND owner_name_snapshot IS NOT NULL AND
      char_length(owner_name_snapshot) BETWEEN 1 AND 200) OR
    (identity_visibility='anonymous' AND owner_name_snapshot IS NULL)
  ),
  CONSTRAINT conversation_share_snapshots_secret_hash_check
    CHECK(secret_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT conversation_share_snapshots_payload_hash_check
    CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT conversation_share_snapshots_idempotency_check
    CHECK(char_length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT conversation_share_snapshots_public_snapshot_check
    CHECK(
      jsonb_typeof(public_snapshot)='object' AND
      public_snapshot->>'id'=id::text AND
      public_snapshot->>'title'=title AND
      public_snapshot->>'conversationVersion'=conversation_version::text AND
      public_snapshot#>>'{identity,visibility}'=identity_visibility AND
      (public_snapshot#>>'{identity,displayName}') IS NOT DISTINCT FROM owner_name_snapshot AND
      public_snapshot->>'attachmentPolicy'=attachment_policy AND
      jsonb_typeof(public_snapshot->'messages')='array' AND
      jsonb_typeof(public_snapshot->'attachments')='array'
    ),
  CONSTRAINT conversation_share_snapshots_source_attachments_check
    CHECK(jsonb_typeof(source_attachments)='object'),
  CONSTRAINT conversation_share_snapshots_expiry_check
    CHECK(expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX conversation_share_snapshots_owner_created_idx
  ON conversation_share_snapshots(owner_id,created_at DESC,id DESC);
CREATE INDEX conversation_share_snapshots_public_expiry_idx
  ON conversation_share_snapshots(expires_at,id)
  WHERE revoked_at IS NULL;

CREATE TRIGGER dg_chat_restore_maintenance_fence
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON conversation_share_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_restore_maintenance();
