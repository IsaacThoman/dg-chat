ALTER TABLE attachments
  ADD COLUMN ingestion_status text NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN ingestion_error text,
  ADD COLUMN ingested_at timestamptz;

ALTER TABLE attachments ADD CONSTRAINT attachments_ingestion_status_check
  CHECK (ingestion_status IN ('not_applicable','queued','processing','ready','failed'));

CREATE UNIQUE INDEX IF NOT EXISTS document_chunks_attachment_ordinal_uq
  ON document_chunks(attachment_id,ordinal);

UPDATE attachments
SET ingestion_status = 'queued'
WHERE state = 'ready' AND mime_type IN ('text/plain','application/json');

INSERT INTO jobs(type,payload,idempotency_key)
SELECT 'attachment.ingest', jsonb_build_object('attachmentId',id,'ownerId',owner_id),
       'attachment.ingest:' || id
FROM attachments
WHERE ingestion_status = 'queued'
ON CONFLICT(idempotency_key) DO NOTHING;
