-- Destination-local control plane for pairing a separately encrypted .dgsecrets artifact with
-- one completed, redacted restore. This table is deliberately excluded from portable backup data.
CREATE TABLE backup_restore_secret_sidecars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restore_operation_id uuid NOT NULL REFERENCES backup_operations(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'uploaded',
  version integer NOT NULL DEFAULT 1,
  idempotency_key text NOT NULL,
  -- Deliberately not foreign keys: this control-plane evidence must survive the next whole-
  -- installation restore, whose TRUNCATE ... CASCADE replaces users and all portable data.
  requested_by uuid,
  applied_by uuid,
  source_object_key text NOT NULL,
  archive_sha256 text NOT NULL,
  archive_bytes bigint NOT NULL,
  sidecar_id uuid NOT NULL,
  recovery_key_id text NOT NULL,
  base_backup_id uuid NOT NULL,
  base_archive_sha256 text NOT NULL,
  base_content_root_sha256 text NOT NULL,
  source_installation_id uuid NOT NULL,
  base_restore_epoch bigint NOT NULL,
  record_count integer,
  records_sha256 text,
  provider_state_sha256 text,
  provider_plan jsonb,
  impact jsonb,
  error text,
  cleanup_checked_at timestamptz,
  cleanup_lease_token uuid,
  cleanup_lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  validated_at timestamptz,
  applied_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_restore_secret_sidecars_restore_uq UNIQUE(restore_operation_id),
  CONSTRAINT backup_restore_secret_sidecars_idempotency_uq
    UNIQUE(restore_operation_id,idempotency_key),
  CONSTRAINT backup_restore_secret_sidecars_status_check
    CHECK(status IN ('uploaded','validated','applied','failed','cancelled')),
  CONSTRAINT backup_restore_secret_sidecars_version_check CHECK(version >= 1),
  CONSTRAINT backup_restore_secret_sidecars_idempotency_check
    CHECK(char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT backup_restore_secret_sidecars_object_key_check CHECK(
    char_length(source_object_key) BETWEEN 1 AND 1024 AND left(source_object_key,1) <> '/' AND
    source_object_key !~ '(^|/)\.\.(/|$)' AND source_object_key !~ '//' AND
    source_object_key !~ '[[:cntrl:]]'),
  CONSTRAINT backup_restore_secret_sidecars_digest_check CHECK(
    archive_sha256 ~ '^[0-9a-f]{64}$' AND
    base_archive_sha256 ~ '^[0-9a-f]{64}$' AND
    base_content_root_sha256 ~ '^[0-9a-f]{64}$' AND
    (records_sha256 IS NULL OR records_sha256 ~ '^[0-9a-f]{64}$') AND
    (provider_state_sha256 IS NULL OR provider_state_sha256 ~ '^[0-9a-f]{64}$')),
  CONSTRAINT backup_restore_secret_sidecars_size_check CHECK(archive_bytes > 0),
  CONSTRAINT backup_restore_secret_sidecars_restore_epoch_check CHECK(base_restore_epoch > 0),
  CONSTRAINT backup_restore_secret_sidecars_key_check
    CHECK(recovery_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT backup_restore_secret_sidecars_validation_check CHECK(
    (record_count IS NULL AND records_sha256 IS NULL AND provider_state_sha256 IS NULL AND
      provider_plan IS NULL AND impact IS NULL AND validated_at IS NULL) OR
    (record_count >= 0 AND records_sha256 IS NOT NULL AND provider_state_sha256 IS NOT NULL AND
      jsonb_typeof(provider_plan)='array' AND jsonb_array_length(provider_plan)=record_count AND
      jsonb_typeof(impact)='object' AND validated_at IS NOT NULL)),
  CONSTRAINT backup_restore_secret_sidecars_error_check
    CHECK(error IS NULL OR char_length(error) BETWEEN 1 AND 1000),
  CONSTRAINT backup_restore_secret_sidecars_cleanup_lease_check CHECK(
    (cleanup_lease_token IS NULL AND cleanup_lease_expires_at IS NULL) OR
    (status IN ('applied','failed','cancelled') AND cleanup_lease_token IS NOT NULL AND
      cleanup_lease_expires_at IS NOT NULL)),
  CONSTRAINT backup_restore_secret_sidecars_time_check CHECK(
    updated_at >= created_at AND
    (validated_at IS NULL OR validated_at >= created_at) AND
    (applied_at IS NULL OR applied_at >= created_at) AND
    (completed_at IS NULL OR completed_at >= created_at)),
  CONSTRAINT backup_restore_secret_sidecars_lifecycle_check CHECK(
    (status='uploaded' AND validated_at IS NULL AND applied_at IS NULL AND completed_at IS NULL AND
      error IS NULL) OR
    (status='validated' AND validated_at IS NOT NULL AND applied_at IS NULL AND
      completed_at IS NULL AND error IS NULL) OR
    (status='applied' AND validated_at IS NOT NULL AND applied_at IS NOT NULL AND
      completed_at IS NOT NULL AND error IS NULL AND applied_by IS NOT NULL) OR
    (status='failed' AND applied_at IS NULL AND completed_at IS NOT NULL AND error IS NOT NULL) OR
    (status='cancelled' AND applied_at IS NULL AND completed_at IS NOT NULL AND error IS NULL))
);

CREATE INDEX backup_restore_secret_sidecars_cleanup_idx
  ON backup_restore_secret_sidecars(cleanup_checked_at,completed_at,id)
  WHERE status IN ('applied','failed','cancelled');
