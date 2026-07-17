-- A pre-atomic generated-asset API inferred staged-object cleanup ownership from content
-- deduplication. When recovery deduplicated to an attachment for the exact same physical key, that
-- attachment owns the staged object and must keep the normal durable-reference fences.
--
-- A stage already marked cleaned is unknowable from PostgreSQL alone: the old worker may have
-- deleted bytes still owned by the same-key attachment. Refuse to continue so an operator can
-- inspect object storage instead of silently accepting corrupt history.
DO $$
BEGIN
  IF EXISTS(
    SELECT 1
    FROM generated_object_staging stage
    JOIN attachments attachment
      ON attachment.owner_id=stage.owner_id AND attachment.id=stage.attachment_id
    WHERE stage.state='cleaned' AND stage.cleanup_attachment=false
      AND attachment.physical_object
      AND attachment.object_key=stage.object_key
  ) THEN
    RAISE EXCEPTION
      'historical generated cleanup ownership is ambiguous after object deletion'
      USING ERRCODE='55000';
  END IF;
END;
$$;

-- Reconcile every non-cleaned exact-identity row before a worker can delete it. Content-deduplicated
-- stages pointing at another retained key remain cleanup-owned by the stage, not the attachment.
WITH reconciled AS (
  UPDATE generated_object_staging stage
  SET cleanup_attachment=true,updated_at=now()
  FROM attachments attachment
  WHERE stage.cleanup_attachment=false AND stage.state<>'cleaned'
    AND attachment.owner_id=stage.owner_id AND attachment.id=stage.attachment_id
    AND attachment.physical_object AND attachment.object_key=stage.object_key
    AND attachment.size_bytes=stage.size_bytes AND attachment.sha256=stage.sha256
    AND attachment.mime_type=stage.mime_type
  RETURNING stage.id,stage.owner_id,stage.attachment_id,stage.usage_run_id,stage.object_key
)
INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
SELECT
  reconciled.owner_id,'attachment.generated_cleanup_ownership_reconciled','attachment',
  reconciled.attachment_id::text,
  jsonb_build_object(
    'stageId',reconciled.id,'usageRunId',reconciled.usage_run_id,'migrationBackfill',true
  )
FROM reconciled;

-- Inspection requirements are an epoch-bound policy snapshot, not physical storage identity.
-- Reinspection may replace them while the owner/key/bytes/physical-object tuple remains immutable.
CREATE OR REPLACE FUNCTION dg_chat_enforce_attachment_identity_immutable() RETURNS trigger
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
  THEN
    RAISE EXCEPTION 'attachment immutable storage identity cannot be changed'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
