ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS embedding_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS embedding_model_id text,
  ADD COLUMN IF NOT EXISTS embedding_config_version text,
  ADD COLUMN IF NOT EXISTS embedded_at timestamptz,
  ADD COLUMN IF NOT EXISTS embedding_error text;

-- Earlier schemas had an unversioned nullable vector column. Such vectors cannot be compared
-- safely because their model/config identity is unknowable, so explicitly return them to pending.
UPDATE document_chunks SET embedding = NULL WHERE embedding IS NOT NULL
  AND (embedding_model_id IS NULL OR embedding_config_version IS NULL);

DO $$ BEGIN
  ALTER TABLE document_chunks ADD CONSTRAINT document_chunks_embedding_state_check CHECK (
    embedding_status IN ('pending', 'ready', 'failed')
    AND ((embedding_status = 'ready' AND embedding IS NOT NULL AND embedding_model_id IS NOT NULL
      AND embedding_config_version IS NOT NULL AND embedded_at IS NOT NULL AND embedding_error IS NULL)
      OR (embedding_status <> 'ready' AND embedding IS NULL AND embedded_at IS NULL))
    AND (embedding_model_id IS NULL OR length(embedding_model_id) BETWEEN 1 AND 255)
    AND (embedding_config_version IS NULL OR embedding_config_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
    AND (embedding_error IS NULL OR length(embedding_error) <= 1000)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS document_chunks_lexical_idx
  ON document_chunks USING gin (to_tsvector('simple', content));
CREATE INDEX IF NOT EXISTS document_chunks_embedding_ready_idx
  ON document_chunks USING hnsw (embedding vector_cosine_ops)
  WHERE embedding_status = 'ready' AND embedding IS NOT NULL;
