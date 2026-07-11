CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE document_chunk_embeddings (
  chunk_id uuid NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 200),
  embedding_version text NOT NULL CHECK (embedding_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  embedding vector(1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, embedding_version)
);
CREATE INDEX document_chunk_embeddings_owner_version_idx
  ON document_chunk_embeddings(owner_id, embedding_version, chunk_id);
CREATE INDEX document_chunk_embeddings_cosine_hnsw_idx
  ON document_chunk_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX document_chunks_lexical_idx
  ON document_chunks USING gin (to_tsvector('simple', content));

CREATE FUNCTION enforce_document_chunk_embedding_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM document_chunks dc
    JOIN attachments a ON a.id=dc.attachment_id
    WHERE dc.id=NEW.chunk_id AND a.owner_id=NEW.owner_id AND a.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'document chunk embedding ownership mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_chunk_embedding_owner
  BEFORE INSERT OR UPDATE ON document_chunk_embeddings
  FOR EACH ROW EXECUTE FUNCTION enforce_document_chunk_embedding_owner();
