-- Migration 0050 introduced cumulative physical-object accounting. Deployments which already
-- applied its original form can contain a narrow legacy terminal state: the generated-object
-- worker deleted an orphan's bytes and committed state='cleaned' before release history existed.
-- Reconcile only that exact state. Anything ambiguous remains operator-visible and fails closed.
DO $$
BEGIN
  IF EXISTS(
    SELECT 1
    FROM generated_object_staging stage
    LEFT JOIN attachments attachment
      ON attachment.owner_id=stage.owner_id AND attachment.id=stage.attachment_id
    LEFT JOIN attachment_storage_blobs blob
      ON blob.owner_id=stage.owner_id AND blob.object_key=stage.object_key
    WHERE stage.state='cleaned' AND stage.cleanup_attachment=true
      AND stage.attachment_id IS NOT NULL
      AND NOT EXISTS(
        SELECT 1 FROM attachment_storage_releases release
        WHERE release.stage_id=stage.id
      )
      AND (
        stage.cleanup_error IS NOT NULL OR attachment.id IS NULL OR
        attachment.state<>'deleted' OR attachment.deleted_at IS NULL OR
        attachment.physical_object IS NOT TRUE OR
        attachment.object_key<>stage.object_key OR
        attachment.size_bytes<>stage.size_bytes OR attachment.sha256<>stage.sha256 OR
        attachment.mime_type<>stage.mime_type OR blob.owner_id IS NULL OR
        blob.size_bytes<>stage.size_bytes OR blob.sha256<>stage.sha256 OR
        blob.mime_type<>stage.mime_type OR
        NOT EXISTS(
          SELECT 1 FROM usage_runs run
          WHERE run.user_id=stage.owner_id AND run.id=stage.usage_run_id
        ) OR
        EXISTS(
          SELECT 1 FROM attachments peer
          WHERE peer.owner_id=stage.owner_id AND peer.object_key=stage.object_key
            AND peer.id<>stage.attachment_id
        ) OR
        EXISTS(
          SELECT 1 FROM message_attachments reference
          WHERE reference.attachment_id=stage.attachment_id
        ) OR
        EXISTS(
          SELECT 1 FROM knowledge_collection_attachments reference
          WHERE reference.attachment_id=stage.attachment_id
        ) OR
        EXISTS(
          SELECT 1 FROM document_chunks reference
          WHERE reference.attachment_id=stage.attachment_id
        ) OR
        EXISTS(
          SELECT 1 FROM generated_assets reference
          WHERE reference.attachment_id=stage.attachment_id
            OR reference.usage_run_id=stage.usage_run_id
        ) OR
        EXISTS(
          SELECT 1 FROM generated_asset_inputs reference
          WHERE reference.attachment_id=stage.attachment_id
        ) OR
        EXISTS(
          SELECT 1 FROM generated_object_staging peer
          WHERE peer.id<>stage.id AND peer.state<>'cleaned'
            AND (
              peer.attachment_id=stage.attachment_id OR
              peer.owner_id=stage.owner_id AND peer.object_key=stage.object_key
            )
        ) OR
        EXISTS(
          SELECT 1 FROM file_upload_staging reference
          WHERE reference.attachment_id=stage.attachment_id OR
            reference.owner_id=stage.owner_id AND reference.object_key=stage.object_key
        ) OR
        EXISTS(
          SELECT 1 FROM attachment_upload_staging reference
          WHERE reference.attachment_id=stage.attachment_id OR
            reference.owner_id=stage.owner_id AND reference.object_key=stage.object_key
        ) OR
        EXISTS(
          SELECT 1 FROM conversation_share_snapshots snapshot
          CROSS JOIN LATERAL jsonb_each(snapshot.source_attachments) source
          WHERE source.value->>'attachmentId'=stage.attachment_id::text
        )
      )
  ) THEN
    RAISE EXCEPTION
      'historical cleaned generated object is fenced by ambiguous durable state'
      USING ERRCODE='55000';
  END IF;
END;
$$;

WITH inserted AS (
  INSERT INTO attachment_storage_releases(
    stage_id,usage_run_id,owner_id,object_key,attachment_id,size_bytes,sha256,mime_type,released_at
  )
  SELECT
    stage.id,stage.usage_run_id,stage.owner_id,stage.object_key,stage.attachment_id,
    stage.size_bytes,stage.sha256,stage.mime_type,
    greatest(stage.updated_at,blob.admitted_at)
  FROM generated_object_staging stage
  JOIN attachment_storage_blobs blob
    ON blob.owner_id=stage.owner_id AND blob.object_key=stage.object_key
  WHERE stage.state='cleaned' AND stage.cleanup_attachment=true
    AND stage.attachment_id IS NOT NULL
    AND NOT EXISTS(
      SELECT 1 FROM attachment_storage_releases release
      WHERE release.stage_id=stage.id
    )
  RETURNING *
)
INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata,created_at)
SELECT
  inserted.owner_id,'attachment.storage_reclaimed','attachment',
  inserted.attachment_id::text,
  jsonb_build_object(
    'sizeBytes',inserted.size_bytes,'stageId',inserted.stage_id,'migrationBackfill',true
  ),
  inserted.released_at
FROM inserted;

-- Recompute rather than decrementing so upgrades remain idempotent at the data level and repair
-- the precise over-count produced by original 0050 without disturbing retained blob history.
UPDATE attachment_storage_usage usage
SET physical_bytes=(
      SELECT COALESCE(sum(blob.size_bytes),0)
      FROM attachment_storage_blobs blob
      LEFT JOIN attachment_storage_releases release
        ON release.owner_id=blob.owner_id AND release.object_key=blob.object_key
      WHERE blob.owner_id=usage.owner_id AND release.id IS NULL
    ),
    physical_objects=(
      SELECT count(*)
      FROM attachment_storage_blobs blob
      LEFT JOIN attachment_storage_releases release
        ON release.owner_id=blob.owner_id AND release.object_key=blob.object_key
      WHERE blob.owner_id=usage.owner_id AND release.id IS NULL
    ),
    updated_at=now();

UPDATE attachment_storage_installation
SET physical_bytes=(
      SELECT COALESCE(sum(blob.size_bytes),0)
      FROM attachment_storage_blobs blob
      LEFT JOIN attachment_storage_releases release
        ON release.owner_id=blob.owner_id AND release.object_key=blob.object_key
      WHERE release.id IS NULL
    ),
    physical_objects=(
      SELECT count(*)
      FROM attachment_storage_blobs blob
      LEFT JOIN attachment_storage_releases release
        ON release.owner_id=blob.owner_id AND release.object_key=blob.object_key
      WHERE release.id IS NULL
    ),
    updated_at=now()
WHERE singleton_id=1;

-- Whole-installation restore replays immutable blob and release history before historical
-- attachment rows. Only the transaction durably bound to that restore may bypass live admission;
-- ordinary inserts continue rejecting released object-key reuse.
CREATE OR REPLACE FUNCTION dg_chat_account_attachment_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $$
DECLARE
  restore_authorized boolean:=false;
  prior_search_path text;
BEGIN
  IF NEW.physical_object IS FALSE THEN RETURN NEW; END IF;
  EXECUTE format('SELECT %I.dg_chat_restore_transaction_authorized($1)',TG_TABLE_SCHEMA)
    INTO restore_authorized USING TG_TABLE_SCHEMA::name;
  IF restore_authorized THEN RETURN NEW; END IF;
  prior_search_path:=current_setting('search_path');
  PERFORM set_config('search_path',format('%I,pg_catalog',TG_TABLE_SCHEMA),true);
  EXECUTE format(
    'SELECT %I.dg_chat_admit_attachment_storage($1,$2,$3,$4,$5,NULL,NULL,NULL,NULL)',
    TG_TABLE_SCHEMA
  ) USING NEW.owner_id,NEW.object_key,NEW.size_bytes,NEW.sha256,NEW.mime_type;
  PERFORM set_config('search_path',prior_search_path,true);
  RETURN NEW;
END;
$$;
