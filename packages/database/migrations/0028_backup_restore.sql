-- Durable control plane for validated installation backups and whole-installation restores.
-- Backup payload tables and object bytes deliberately remain outside this control plane.
CREATE TABLE backup_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  version integer NOT NULL DEFAULT 1,
  -- Deliberately not a foreign key: backup operations are control-plane evidence that must survive
  -- replacement of the users table during a whole-installation restore.
  actor_id uuid,
  actor_email text NOT NULL,
  actor_name text NOT NULL,
  idempotency_key text NOT NULL,
  stage text NOT NULL DEFAULT 'queued',
  source_object_key text,
  artifact_object_key text,
  archive_sha256 text,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  manifest jsonb,
  impact jsonb,
  confirmation_fingerprint text,
  objects_processed integer NOT NULL DEFAULT 0,
  objects_total integer NOT NULL DEFAULT 0,
  bytes_processed bigint NOT NULL DEFAULT 0,
  bytes_total bigint NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  validated_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_operations_idempotency_uq UNIQUE(actor_id,kind,idempotency_key),
  CONSTRAINT backup_operations_kind_check CHECK(kind IN ('export','restore')),
  CONSTRAINT backup_operations_status_check CHECK(
    status IN ('queued','running','validated','completed','failed','cancelled')),
  CONSTRAINT backup_operations_version_check CHECK(version >= 1),
  CONSTRAINT backup_operations_idempotency_check CHECK(
    char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT backup_operations_stage_check CHECK(char_length(stage) BETWEEN 1 AND 80),
  CONSTRAINT backup_operations_actor_check CHECK(
    char_length(actor_email) BETWEEN 3 AND 320 AND char_length(actor_name) BETWEEN 1 AND 200),
  CONSTRAINT backup_operations_object_key_check CHECK(
    (source_object_key IS NULL OR (
      char_length(source_object_key) BETWEEN 1 AND 1024 AND left(source_object_key,1) <> '/')) AND
    (artifact_object_key IS NULL OR (
      char_length(artifact_object_key) BETWEEN 1 AND 1024 AND left(artifact_object_key,1) <> '/'))),
  CONSTRAINT backup_operations_digest_check CHECK(
    archive_sha256 IS NULL OR archive_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT backup_operations_fingerprint_check CHECK(
    confirmation_fingerprint IS NULL OR confirmation_fingerprint ~ '^[A-F0-9]{8}$'),
  CONSTRAINT backup_operations_json_check CHECK(
    jsonb_typeof(options)='object' AND
    (manifest IS NULL OR jsonb_typeof(manifest)='object') AND
    (impact IS NULL OR jsonb_typeof(impact)='object')),
  CONSTRAINT backup_operations_progress_check CHECK(
    objects_processed >= 0 AND objects_total >= 0 AND
    objects_processed <= objects_total AND bytes_processed >= 0 AND bytes_total >= 0 AND
    bytes_processed <= bytes_total),
  CONSTRAINT backup_operations_error_check CHECK(
    error IS NULL OR char_length(error) BETWEEN 1 AND 1000),
  CONSTRAINT backup_operations_time_check CHECK(
    updated_at >= created_at AND
    (started_at IS NULL OR started_at >= created_at) AND
    (validated_at IS NULL OR validated_at >= created_at) AND
    (completed_at IS NULL OR completed_at >= created_at)),
  CONSTRAINT backup_operations_lifecycle_check CHECK(
    (status='queued' AND started_at IS NULL AND completed_at IS NULL AND error IS NULL) OR
    (status='running' AND started_at IS NOT NULL AND completed_at IS NULL AND error IS NULL) OR
    (status='validated' AND kind='restore' AND started_at IS NOT NULL AND validated_at IS NOT NULL
      AND completed_at IS NULL AND error IS NULL AND archive_sha256 IS NOT NULL
      AND impact IS NOT NULL AND confirmation_fingerprint IS NOT NULL) OR
    (status='completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL AND error IS NULL
      AND archive_sha256 IS NOT NULL) OR
    (status='failed' AND started_at IS NOT NULL AND completed_at IS NOT NULL AND error IS NOT NULL) OR
    (status='cancelled' AND completed_at IS NOT NULL AND error IS NULL))
);
CREATE INDEX backup_operations_status_created_idx
  ON backup_operations(status,created_at,id);
CREATE INDEX backup_operations_kind_created_idx
  ON backup_operations(kind,created_at DESC,id DESC);

CREATE TABLE installation_state (
  singleton_id smallint PRIMARY KEY DEFAULT 1,
  installation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  maintenance_enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  restore_epoch bigint NOT NULL DEFAULT 0,
  active_restore_id uuid REFERENCES backup_operations(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT installation_state_installation_uq UNIQUE(installation_id),
  CONSTRAINT installation_state_singleton_check CHECK(singleton_id=1),
  CONSTRAINT installation_state_version_check CHECK(version >= 1),
  CONSTRAINT installation_state_restore_epoch_check CHECK(restore_epoch >= 0),
  CONSTRAINT installation_state_maintenance_check CHECK(
    maintenance_enabled = (active_restore_id IS NOT NULL))
);
INSERT INTO installation_state(singleton_id) VALUES(1);

-- The HTTP maintenance middleware improves UX, but it cannot fence requests already executing on
-- another replica or a background worker. Enforce the restore fence at the database boundary for
-- every existing application table. Only the backup control plane remains writable so it can
-- record progress and atomically release the fence. The restore transaction uses a transaction-local
-- setting after proving ownership under the restore advisory lock; it cannot leak through pooling.
CREATE FUNCTION dg_chat_enforce_restore_maintenance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE restore_active boolean;
BEGIN
  IF current_setting('dg_chat.restore_bypass', true) = 'on' THEN
    RETURN NULL;
  END IF;
  -- The shared row lock makes fence acquisition wait for pre-existing mutation transactions and
  -- makes new mutation statements wait for an in-progress acquisition. Under repeatable-read or
  -- serializable isolation a stale snapshot fails serialization instead of writing through it.
  SELECT maintenance_enabled INTO restore_active
  FROM installation_state WHERE singleton_id=1 FOR SHARE;
  IF COALESCE(restore_active,false) THEN
    RAISE EXCEPTION 'installation restore maintenance is active'
      USING ERRCODE='55000', HINT='Retry after the active restore completes.';
  END IF;
  RETURN NULL;
END;
$$;

DO $$
DECLARE application_table record;
BEGIN
  FOR application_table IN
    SELECT table_name FROM information_schema.tables
    WHERE table_schema=current_schema() AND table_type='BASE TABLE'
      AND table_name NOT IN ('backup_operations','installation_state','repository_migrations')
    ORDER BY table_name
  LOOP
    EXECUTE format(
      'CREATE TRIGGER dg_chat_restore_maintenance_fence
       BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I
       FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_restore_maintenance()',
      application_table.table_name
    );
  END LOOP;
END;
$$;
