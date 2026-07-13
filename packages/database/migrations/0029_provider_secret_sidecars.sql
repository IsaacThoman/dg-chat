-- Durable lifecycle metadata for the separately encrypted privileged provider-secret artifact.
-- The ordinary .dgbackup remains redacted; these fields only identify the paired .dgsecrets
-- ciphertext and deliberately never contain provider credentials or encryption envelopes.
ALTER TABLE backup_operations
  ADD COLUMN provider_secrets_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN secret_artifact_object_key text,
  ADD COLUMN secret_archive_sha256 text,
  ADD COLUMN secret_archive_bytes bigint,
  ADD COLUMN secret_provider_count integer,
  ADD COLUMN secret_recovery_key_id text,
  ADD COLUMN secret_artifact_cleanup_checked_at timestamptz,
  ADD COLUMN secret_artifact_cleanup_lease_token uuid,
  ADD COLUMN secret_artifact_cleanup_lease_expires_at timestamptz;

ALTER TABLE backup_operations
  ADD CONSTRAINT backup_operations_provider_secrets_kind_check CHECK(
    NOT provider_secrets_requested OR kind='export'),
  ADD CONSTRAINT backup_operations_secret_object_key_check CHECK(
    secret_artifact_object_key IS NULL OR (
      char_length(secret_artifact_object_key) BETWEEN 1 AND 1024 AND
      left(secret_artifact_object_key,1) <> '/')),
  ADD CONSTRAINT backup_operations_secret_digest_check CHECK(
    secret_archive_sha256 IS NULL OR secret_archive_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT backup_operations_secret_metadata_check CHECK(
    (secret_artifact_object_key IS NULL AND secret_archive_sha256 IS NULL AND
      secret_archive_bytes IS NULL AND secret_provider_count IS NULL AND
      secret_recovery_key_id IS NULL) OR
    (provider_secrets_requested AND kind='export' AND secret_artifact_object_key IS NOT NULL AND
      secret_archive_sha256 IS NOT NULL AND secret_archive_bytes > 0 AND
      secret_provider_count >= 0 AND char_length(secret_recovery_key_id) BETWEEN 1 AND 128)),
  ADD CONSTRAINT backup_operations_secret_completion_check CHECK(
    status <> 'completed' OR NOT provider_secrets_requested OR
    (secret_artifact_object_key IS NOT NULL AND secret_archive_sha256 IS NOT NULL AND
      secret_archive_bytes IS NOT NULL AND secret_provider_count IS NOT NULL AND
      secret_recovery_key_id IS NOT NULL)),
  ADD CONSTRAINT backup_operations_secret_cleanup_lease_check CHECK(
    (secret_artifact_cleanup_lease_token IS NULL AND
      secret_artifact_cleanup_lease_expires_at IS NULL) OR
    (kind='export' AND status IN ('failed','cancelled') AND
      secret_artifact_object_key IS NOT NULL AND secret_archive_sha256 IS NOT NULL AND
      secret_artifact_cleanup_lease_token IS NOT NULL AND
      secret_artifact_cleanup_lease_expires_at IS NOT NULL));

CREATE INDEX backup_operations_secret_cleanup_idx
  ON backup_operations(secret_artifact_cleanup_checked_at,created_at,id)
  WHERE kind='export' AND status IN ('failed','cancelled')
    AND secret_artifact_object_key IS NOT NULL AND secret_archive_sha256 IS NOT NULL;
