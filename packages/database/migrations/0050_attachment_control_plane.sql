ALTER TABLE attachments
  ADD COLUMN inspection_epoch integer NOT NULL DEFAULT 1,
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN physical_object boolean NOT NULL DEFAULT true,
  ADD COLUMN required_inspection_mode text NOT NULL DEFAULT 'local',
  ADD COLUMN inspection_policy_version text NOT NULL DEFAULT 'worker-policy-v1',
  ADD CONSTRAINT attachments_inspection_epoch_check CHECK(inspection_epoch>=1),
  ADD CONSTRAINT attachments_version_check CHECK(version>=1),
  ADD CONSTRAINT attachments_required_inspection_mode_check
    CHECK(required_inspection_mode IN ('local','external')),
  ADD CONSTRAINT attachments_inspection_policy_version_check
    CHECK(inspection_policy_version='worker-policy-v1');

-- Conversation-manifest imports created metadata-only attachment tombstones before the schema
-- could represent physical presence explicitly. Classify only the exact server-authored shape
-- before retained-blob backfill; a merely failed/deleted attachment must remain billable.
UPDATE attachments
SET physical_object=false
WHERE object_key='imports/' || owner_id::text || '/' || id::text || '/manifest-only'
  AND state='failed'
  AND deleted_at IS NOT NULL
  AND inspection_error='Attachment bytes were not included in the .dgchat manifest'
  AND ingestion_status='failed'
  AND ingestion_error='Attachment bytes require a separate restore'
  AND ingested_at IS NULL;

ALTER TABLE file_upload_staging
  DROP CONSTRAINT file_upload_staging_attachment_state_check,
  ADD COLUMN required_inspection_mode text NOT NULL DEFAULT 'local',
  ADD COLUMN inspection_policy_version text NOT NULL DEFAULT 'worker-policy-v1',
  ADD CONSTRAINT file_upload_staging_attachment_state_check
    CHECK(attachment_state IN ('pending','ready','quarantined')),
  ADD CONSTRAINT file_upload_staging_required_inspection_mode_check
    CHECK(required_inspection_mode IN ('local','external')),
  ADD CONSTRAINT file_upload_staging_inspection_policy_version_check
    CHECK(inspection_policy_version='worker-policy-v1');

UPDATE attachments
SET inspection_error=CASE state
  WHEN 'quarantined' THEN 'Attachment quarantined by an earlier inspection policy'
  WHEN 'failed' THEN 'Attachment inspection failed before reason tracking'
  ELSE inspection_error
END
WHERE state IN ('quarantined','failed')
  AND (inspection_error IS NULL OR btrim(inspection_error)='');
ALTER TABLE attachments
  ADD CONSTRAINT attachments_terminal_inspection_reason_check CHECK(
    state NOT IN ('quarantined','failed') OR
    inspection_error IS NOT NULL AND char_length(btrim(inspection_error)) BETWEEN 1 AND 1000
  );

CREATE FUNCTION dg_chat_enforce_attachment_identity_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $$
DECLARE
  restore_authorized boolean:=false;
BEGIN
  EXECUTE format('SELECT %I.dg_chat_restore_transaction_authorized($1)',TG_TABLE_SCHEMA)
    INTO restore_authorized USING TG_TABLE_SCHEMA::name;
  IF restore_authorized THEN RETURN NEW; END IF;
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.object_key IS DISTINCT FROM OLD.object_key
    OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.physical_object IS DISTINCT FROM OLD.physical_object
    OR NEW.required_inspection_mode IS DISTINCT FROM OLD.required_inspection_mode
    OR NEW.inspection_policy_version IS DISTINCT FROM OLD.inspection_policy_version
  THEN
    RAISE EXCEPTION 'attachment immutable storage identity cannot be changed'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER dg_chat_attachment_identity_immutable
  BEFORE UPDATE ON attachments
  FOR EACH ROW EXECUTE FUNCTION dg_chat_enforce_attachment_identity_immutable();

CREATE INDEX attachments_admin_cursor_idx ON attachments(created_at DESC,id DESC);
CREATE INDEX attachments_admin_state_cursor_idx
  ON attachments(state,created_at DESC,id DESC);
CREATE INDEX attachments_admin_owner_cursor_idx
  ON attachments(owner_id,created_at DESC,id DESC);

-- This registry represents retained physical blobs, not mutable attachment metadata. A soft
-- deletion cannot lower either quota because historical message branches may still reference it.
CREATE TABLE attachment_storage_blobs(
  owner_id uuid NOT NULL REFERENCES users(id),
  object_key text NOT NULL,
  size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 0 AND 9007199254740991),
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text NOT NULL CHECK(
    char_length(mime_type) BETWEEN 3 AND 255 AND
    mime_type ~ '^[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+$'
  ),
  admitted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,object_key)
);
-- Admission history remains immutable. A separate append-only row records the one narrowly
-- authorized transition from physically retained to proven-deleted generated orphan.
CREATE TABLE attachment_storage_releases(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id uuid NOT NULL UNIQUE,
  usage_run_id text NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id),
  object_key text NOT NULL,
  attachment_id uuid NOT NULL,
  size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 0 AND 9007199254740991),
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text NOT NULL CHECK(
    char_length(mime_type) BETWEEN 3 AND 255 AND
    mime_type ~ '^[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+$'
  ),
  reason text NOT NULL DEFAULT 'generated_object_cleanup'
    CHECK(reason='generated_object_cleanup'),
  released_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attachment_storage_releases_blob_fk
    FOREIGN KEY(owner_id,object_key)
    REFERENCES attachment_storage_blobs(owner_id,object_key),
  CONSTRAINT attachment_storage_releases_usage_fk
    FOREIGN KEY(owner_id,usage_run_id)
    REFERENCES usage_runs(user_id,id) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT attachment_storage_releases_attachment_fk
    FOREIGN KEY(owner_id,attachment_id)
    REFERENCES attachments(owner_id,id) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT attachment_storage_releases_object_uq UNIQUE(owner_id,object_key)
);
CREATE TABLE attachment_storage_usage(
  owner_id uuid PRIMARY KEY REFERENCES users(id),
  physical_bytes bigint NOT NULL DEFAULT 0
    CHECK(physical_bytes BETWEEN 0 AND 9007199254740991),
  physical_objects bigint NOT NULL DEFAULT 0
    CHECK(physical_objects BETWEEN 0 AND 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE attachment_storage_installation(
  singleton_id integer PRIMARY KEY DEFAULT 1 CHECK(singleton_id=1),
  physical_bytes bigint NOT NULL DEFAULT 0
    CHECK(physical_bytes BETWEEN 0 AND 9007199254740991),
  physical_objects bigint NOT NULL DEFAULT 0
    CHECK(physical_objects BETWEEN 0 AND 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO attachment_storage_installation(singleton_id) VALUES(1);

-- Browser uploads are staged before the object-store PUT. This durable row gives a cleanup worker
-- exact authority after a lost PUT acknowledgement, quota rejection, or database outage instead
-- of relying on best-effort request cleanup.
CREATE TABLE attachment_upload_staging(
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  object_key text NOT NULL UNIQUE,
  filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 0 AND 26214400),
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN(
    'pending','stored','cleanup_pending','cleaning','finalized','cleaned','abandoned'
  )),
  attachment_id uuid,
  cleanup_error text,
  upload_lease_token uuid NOT NULL DEFAULT gen_random_uuid(),
  upload_lease_expires_at timestamptz NOT NULL DEFAULT (now()+interval '15 minutes'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attachment_upload_staging_attachment_fk
    FOREIGN KEY(owner_id,attachment_id) REFERENCES attachments(owner_id,id),
  CONSTRAINT attachment_upload_staging_filename_check
    CHECK(char_length(filename) BETWEEN 1 AND 255),
  CONSTRAINT attachment_upload_staging_mime_check CHECK(
    char_length(mime_type) BETWEEN 3 AND 255 AND
    mime_type ~ '^[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+$'
  ),
  CONSTRAINT attachment_upload_staging_key_check CHECK(
    char_length(object_key) BETWEEN 1 AND 1024 AND left(object_key,1)<>'/'
  ),
  CONSTRAINT attachment_upload_staging_cleanup_error_check CHECK(
    cleanup_error IS NULL OR char_length(cleanup_error) BETWEEN 1 AND 1000
  )
);
CREATE INDEX attachment_upload_staging_cleanup_idx
  ON attachment_upload_staging(state,upload_lease_expires_at,updated_at,id)
  WHERE state IN('cleanup_pending','cleaning');

DO $$
BEGIN
  IF EXISTS(
    SELECT 1 FROM attachments
    WHERE physical_object=true
    GROUP BY owner_id,object_key
    HAVING min(size_bytes)<>max(size_bytes) OR min(sha256)<>max(sha256)
      OR min(mime_type)<>max(mime_type)
  ) THEN
    RAISE EXCEPTION
      'existing attachment object metadata conflicts with retained storage accounting'
      USING ERRCODE='23514';
  END IF;
END;
$$;

INSERT INTO attachment_storage_blobs(
  owner_id,object_key,size_bytes,sha256,mime_type,admitted_at
)
SELECT DISTINCT ON(owner_id,object_key)
  owner_id,object_key,size_bytes,sha256,mime_type,created_at
FROM attachments
WHERE physical_object=true
ORDER BY owner_id,object_key,created_at,id;
INSERT INTO attachment_storage_usage(owner_id,physical_bytes,physical_objects)
SELECT owner_id,sum(size_bytes),count(*)
FROM attachment_storage_blobs
GROUP BY owner_id;
UPDATE attachment_storage_installation
SET physical_bytes=(SELECT COALESCE(sum(size_bytes),0) FROM attachment_storage_blobs),
    physical_objects=(SELECT count(*) FROM attachment_storage_blobs),
    updated_at=now()
WHERE singleton_id=1;

-- Lock order is installation then owner. Every repository admission and the defensive INSERT
-- trigger below therefore serializes quota decisions without scanning attachment history.
CREATE FUNCTION dg_chat_admit_attachment_storage(
  admitted_owner_id uuid,
  admitted_object_key text,
  admitted_size_bytes bigint,
  admitted_sha256 text,
  admitted_mime_type text,
  per_user_limit_bytes bigint DEFAULT NULL,
  per_user_limit_objects bigint DEFAULT NULL,
  installation_limit_bytes bigint DEFAULT NULL,
  installation_limit_objects bigint DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  installation attachment_storage_installation%ROWTYPE;
  owner_usage attachment_storage_usage%ROWTYPE;
  prior attachment_storage_blobs%ROWTYPE;
BEGIN
  IF admitted_size_bytes<0 OR admitted_size_bytes>9007199254740991
    OR admitted_sha256 !~ '^[0-9a-f]{64}$'
    OR char_length(admitted_mime_type) NOT BETWEEN 3 AND 255
    OR admitted_mime_type !~ '^[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+$'
    OR per_user_limit_bytes IS NOT NULL
      AND (per_user_limit_bytes<0 OR per_user_limit_bytes>9007199254740991)
    OR per_user_limit_objects IS NOT NULL
      AND (per_user_limit_objects<0 OR per_user_limit_objects>9007199254740991)
    OR installation_limit_bytes IS NOT NULL
      AND (installation_limit_bytes<0 OR installation_limit_bytes>9007199254740991)
    OR installation_limit_objects IS NOT NULL
      AND (installation_limit_objects<0 OR installation_limit_objects>9007199254740991)
  THEN RAISE EXCEPTION 'attachment storage admission is invalid' USING ERRCODE='22023';
  END IF;

  SELECT * INTO installation FROM attachment_storage_installation
  WHERE singleton_id=1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attachment storage installation state is missing' USING ERRCODE='55000';
  END IF;
  INSERT INTO attachment_storage_usage(owner_id) VALUES(admitted_owner_id)
  ON CONFLICT(owner_id) DO NOTHING;
  SELECT * INTO owner_usage FROM attachment_storage_usage
  WHERE owner_id=admitted_owner_id FOR UPDATE;

  SELECT * INTO prior FROM attachment_storage_blobs
  WHERE owner_id=admitted_owner_id AND object_key=admitted_object_key;
  IF FOUND THEN
    IF prior.size_bytes<>admitted_size_bytes OR prior.sha256<>admitted_sha256 OR
       prior.mime_type<>admitted_mime_type THEN
      RAISE EXCEPTION 'attachment object metadata differs from retained blob'
        USING ERRCODE='23514';
    END IF;
    IF EXISTS(
      SELECT 1 FROM attachment_storage_releases
      WHERE owner_id=admitted_owner_id AND object_key=admitted_object_key
    ) THEN
      RAISE EXCEPTION 'released attachment object keys cannot be reused'
        USING ERRCODE='23514';
    END IF;
    RETURN false;
  END IF;
  IF per_user_limit_bytes IS NOT NULL
    AND owner_usage.physical_bytes>per_user_limit_bytes-admitted_size_bytes
  THEN RAISE EXCEPTION 'per-user attachment storage quota exceeded' USING ERRCODE='P0001';
  END IF;
  IF per_user_limit_objects IS NOT NULL
    AND owner_usage.physical_objects>=per_user_limit_objects
  THEN RAISE EXCEPTION 'per-user attachment object quota exceeded' USING ERRCODE='P0001';
  END IF;
  IF installation_limit_bytes IS NOT NULL
    AND installation.physical_bytes>installation_limit_bytes-admitted_size_bytes
  THEN RAISE EXCEPTION 'installation attachment storage quota exceeded' USING ERRCODE='P0001';
  END IF;
  IF installation_limit_objects IS NOT NULL
    AND installation.physical_objects>=installation_limit_objects
  THEN RAISE EXCEPTION 'installation attachment object quota exceeded' USING ERRCODE='P0001';
  END IF;

  INSERT INTO attachment_storage_blobs(owner_id,object_key,size_bytes,sha256,mime_type)
  VALUES(
    admitted_owner_id,admitted_object_key,admitted_size_bytes,admitted_sha256,
    admitted_mime_type
  );
  UPDATE attachment_storage_usage
  SET physical_bytes=physical_bytes+admitted_size_bytes,
      physical_objects=physical_objects+1,updated_at=now()
  WHERE owner_id=admitted_owner_id;
  UPDATE attachment_storage_installation
  SET physical_bytes=physical_bytes+admitted_size_bytes,
      physical_objects=physical_objects+1,updated_at=now()
  WHERE singleton_id=1;
  RETURN true;
END;
$$;

CREATE FUNCTION dg_chat_account_attachment_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.physical_object IS FALSE THEN RETURN NEW; END IF;
  PERFORM dg_chat_admit_attachment_storage(
    NEW.owner_id,NEW.object_key,NEW.size_bytes,NEW.sha256,NEW.mime_type,
    NULL,NULL,NULL,NULL
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER dg_chat_attachment_storage_admission
  BEFORE INSERT ON attachments
  FOR EACH ROW EXECUTE FUNCTION dg_chat_account_attachment_insert();

-- Blob history is immutable. Whole-installation restore remains the only authority for arbitrary
-- rewrites; a generated orphan release appends to attachment_storage_releases instead.
CREATE FUNCTION dg_chat_enforce_attachment_blob_history() RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $$
DECLARE
  restore_authorized boolean:=false;
  test_transaction text;
  test_authorized boolean:=false;
BEGIN
  EXECUTE format('SELECT %I.dg_chat_restore_transaction_authorized($1)',TG_TABLE_SCHEMA)
    INTO restore_authorized USING TG_TABLE_SCHEMA::name;
  IF restore_authorized THEN RETURN COALESCE(NEW,OLD); END IF;
  test_transaction:=current_setting('dg_chat.audit_test_maintenance_transaction',true);
  IF test_transaction IS NOT NULL AND test_transaction ~ '^[0-9]+$'
    AND test_transaction=pg_current_xact_id()::text
    AND current_database() ~ '^dgchat_ci_[a-z0-9_]{1,30}_[a-z][a-z0-9_]{0,23}$'
  THEN
    SELECT role.rolsuper AND EXISTS(
      SELECT 1 FROM pg_locks held
      WHERE held.locktype='advisory' AND held.pid=pg_backend_pid() AND held.granted=true
        AND held.mode='ExclusiveLock'
        AND held.classid::bigint =
          ((hashtext('dg-chat-audit-test-maintenance')::bigint >> 32) & 4294967295)
        AND held.objid::bigint =
          (hashtext('dg-chat-audit-test-maintenance')::bigint & 4294967295)
        AND held.objsubid=1
    ) INTO test_authorized
    FROM pg_roles role WHERE role.rolname=current_user;
  END IF;
  IF COALESCE(test_authorized,false) THEN RETURN COALESCE(NEW,OLD); END IF;
  RAISE EXCEPTION 'attachment_storage_blobs is append-only'
    USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER dg_chat_attachment_storage_blobs_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON attachment_storage_blobs
  FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_attachment_blob_history();

-- Called only after the object-store DELETE succeeds. Every durable reference class is checked
-- again in the same transaction as counter settlement. A crash before commit safely over-counts;
-- replay repeats the idempotent object delete and settles once. A crash after commit observes the
-- append-only release row and cannot decrement again.
CREATE FUNCTION dg_chat_settle_generated_object_cleanup(
  settled_stage_id uuid,
  settled_owner_id uuid,
  target_schema name DEFAULT current_schema()
) RETURNS boolean
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $$
DECLARE
  installation record;
  owner_usage record;
  blob record;
  stage record;
  target_attachment record;
  reference_exists boolean:=false;
BEGIN
  EXECUTE format(
    'SELECT physical_bytes,physical_objects FROM %I.attachment_storage_installation
      WHERE singleton_id=1 FOR UPDATE',target_schema
  ) INTO installation;
  IF installation IS NULL THEN
    RAISE EXCEPTION 'attachment storage installation state is missing' USING ERRCODE='55000';
  END IF;
  EXECUTE format(
    'SELECT physical_bytes,physical_objects FROM %I.attachment_storage_usage
      WHERE owner_id=$1 FOR UPDATE',target_schema
  ) INTO owner_usage USING settled_owner_id;
  IF owner_usage IS NULL THEN
    RAISE EXCEPTION 'attachment storage owner state is missing' USING ERRCODE='55000';
  END IF;
  EXECUTE format(
    'SELECT attachment_id,state,cleanup_attachment,object_key,size_bytes,sha256,mime_type,usage_run_id
       FROM %I.generated_object_staging
      WHERE id=$1 AND owner_id=$2 FOR UPDATE',target_schema
  ) INTO stage USING settled_stage_id,settled_owner_id;
  IF stage IS NULL OR stage.state NOT IN ('cleaning','cleaned') THEN
    RAISE EXCEPTION 'attachment storage release stage is invalid' USING ERRCODE='55000';
  END IF;
  IF stage.state='cleaned' THEN
    IF stage.cleanup_attachment IS FALSE THEN RETURN false; END IF;
    EXECUTE format(
      'SELECT EXISTS(SELECT 1 FROM %I.attachment_storage_releases
        WHERE stage_id=$1 AND owner_id=$2 AND object_key=$3)',target_schema
    ) INTO reference_exists USING settled_stage_id,settled_owner_id,stage.object_key;
    IF reference_exists THEN RETURN false; END IF;
    RAISE EXCEPTION 'cleaned generated stage has no storage release'
      USING ERRCODE='55000';
  END IF;
  IF stage.cleanup_attachment IS FALSE THEN
    EXECUTE format(
      'UPDATE %I.generated_object_staging
          SET state=''cleaned'',cleanup_error=NULL,updated_at=now()
        WHERE id=$1 AND owner_id=$2 AND state=''cleaning''',target_schema
    ) USING settled_stage_id,settled_owner_id;
    RETURN false;
  END IF;
  IF stage.attachment_id IS NULL THEN
    RAISE EXCEPTION 'attachment storage release attachment is missing' USING ERRCODE='55000';
  END IF;
  EXECUTE format(
    'SELECT id,state,deleted_at,object_key,size_bytes,sha256,mime_type,physical_object
       FROM %I.attachments WHERE id=$1 AND owner_id=$2 FOR UPDATE',target_schema
  ) INTO target_attachment USING stage.attachment_id,settled_owner_id;
  IF target_attachment IS NULL OR target_attachment.state<>'deleted' OR
     target_attachment.deleted_at IS NULL OR target_attachment.object_key<>stage.object_key OR
     target_attachment.size_bytes<>stage.size_bytes OR target_attachment.sha256<>stage.sha256 OR
     target_attachment.mime_type<>stage.mime_type OR target_attachment.physical_object IS NOT TRUE
  THEN
    RAISE EXCEPTION 'attachment storage release requires the exact tombstoned attachment'
      USING ERRCODE='55000';
  END IF;
  EXECUTE format(
    'SELECT size_bytes,sha256,mime_type FROM %I.attachment_storage_blobs
      WHERE owner_id=$1 AND object_key=$2 FOR UPDATE',target_schema
  ) INTO blob USING settled_owner_id,stage.object_key;
  IF blob IS NULL OR blob.size_bytes<>stage.size_bytes OR blob.sha256<>stage.sha256 OR
     blob.mime_type<>target_attachment.mime_type THEN
    RAISE EXCEPTION 'attachment storage blob is missing or differs from generated stage'
      USING ERRCODE='55000';
  END IF;
  EXECUTE format(
    'SELECT EXISTS(SELECT 1 FROM %I.attachment_storage_releases
      WHERE owner_id=$1 AND object_key=$2)',target_schema
  ) INTO reference_exists USING settled_owner_id,stage.object_key;
  IF reference_exists THEN
    RAISE EXCEPTION 'attachment storage blob was released by another lifecycle'
      USING ERRCODE='55000';
  END IF;
  EXECUTE format(
    'SELECT EXISTS(
       SELECT 1 FROM %1$I.attachments a
        WHERE a.owner_id=$1 AND a.object_key=$2 AND
          (a.id<>$3 OR a.deleted_at IS NULL OR a.state<>''deleted'')
       UNION ALL SELECT 1 FROM %1$I.message_attachments r WHERE r.attachment_id=$3
       UNION ALL SELECT 1 FROM %1$I.knowledge_collection_attachments r
        WHERE r.attachment_id=$3
       UNION ALL SELECT 1 FROM %1$I.document_chunks r WHERE r.attachment_id=$3
       UNION ALL SELECT 1 FROM %1$I.generated_assets r
        WHERE r.attachment_id=$3 OR r.usage_run_id=$4
       UNION ALL SELECT 1 FROM %1$I.generated_asset_inputs r WHERE r.attachment_id=$3
       UNION ALL SELECT 1 FROM %1$I.generated_object_staging r
        WHERE r.id<>$5 AND r.state<>''cleaned'' AND
          (r.attachment_id=$3 OR r.owner_id=$1 AND r.object_key=$2)
       UNION ALL SELECT 1 FROM %1$I.file_upload_staging r
        WHERE r.attachment_id=$3 OR r.owner_id=$1 AND r.object_key=$2
       UNION ALL SELECT 1 FROM %1$I.attachment_upload_staging r
        WHERE r.attachment_id=$3 OR r.owner_id=$1 AND r.object_key=$2
       UNION ALL SELECT 1 FROM %1$I.conversation_share_snapshots snapshot
        CROSS JOIN LATERAL jsonb_each(snapshot.source_attachments) source
        WHERE source.value->>''attachmentId''=$3::text
     )',target_schema
  ) INTO reference_exists USING settled_owner_id,stage.object_key,stage.attachment_id,
    stage.usage_run_id,settled_stage_id;
  IF reference_exists THEN
    RAISE EXCEPTION 'attachment storage release is fenced by a durable reference'
      USING ERRCODE='55000';
  END IF;
  IF owner_usage.physical_bytes<blob.size_bytes OR owner_usage.physical_objects<1 OR
     installation.physical_bytes<blob.size_bytes OR installation.physical_objects<1 THEN
    RAISE EXCEPTION 'attachment storage accounting would underflow' USING ERRCODE='55000';
  END IF;
  EXECUTE format(
    'INSERT INTO %I.attachment_storage_releases(
       stage_id,usage_run_id,owner_id,object_key,attachment_id,size_bytes,sha256,mime_type)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)',target_schema
  ) USING settled_stage_id,stage.usage_run_id,settled_owner_id,stage.object_key,
    stage.attachment_id,blob.size_bytes,blob.sha256,blob.mime_type;
  EXECUTE format(
    'UPDATE %I.attachment_storage_usage
        SET physical_bytes=physical_bytes-$2,physical_objects=physical_objects-1,updated_at=now()
      WHERE owner_id=$1',target_schema
  ) USING settled_owner_id,blob.size_bytes;
  EXECUTE format(
    'UPDATE %I.attachment_storage_installation
        SET physical_bytes=physical_bytes-$1,physical_objects=physical_objects-1,updated_at=now()
      WHERE singleton_id=1',target_schema
  ) USING blob.size_bytes;
  EXECUTE format(
    'UPDATE %I.generated_object_staging
        SET state=''cleaned'',cleanup_error=NULL,updated_at=now()
      WHERE id=$1 AND owner_id=$2 AND state=''cleaning''',target_schema
  ) USING settled_stage_id,settled_owner_id;
  EXECUTE format(
    'INSERT INTO %I.audit_events(actor_id,action,target_type,target_id,metadata)
     VALUES($1,''attachment.storage_reclaimed'',''attachment'',$2,
       jsonb_build_object(''sizeBytes'',$3,''stageId'',$4))',target_schema
  ) USING settled_owner_id,stage.attachment_id::text,blob.size_bytes,settled_stage_id;
  RETURN true;
END;
$$;

CREATE TRIGGER dg_chat_restore_maintenance_fence
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON attachment_storage_blobs
  FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_restore_maintenance();

CREATE TRIGGER dg_chat_attachment_storage_releases_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON attachment_storage_releases
  FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_attachment_blob_history();
CREATE TRIGGER dg_chat_restore_maintenance_fence
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON attachment_storage_releases
  FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_restore_maintenance();

CREATE TRIGGER dg_chat_restore_maintenance_fence
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON attachment_storage_usage
  FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_restore_maintenance();
CREATE TRIGGER dg_chat_restore_maintenance_fence
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON attachment_storage_installation
  FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_restore_maintenance();
CREATE TRIGGER dg_chat_restore_maintenance_fence
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON attachment_upload_staging
  FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_restore_maintenance();
