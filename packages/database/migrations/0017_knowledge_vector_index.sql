-- 0013 was deployed by early adopters before the dedicated versioned-vector HNSW index was added.
-- Repeat it in an immutable follow-up migration so upgraded installations receive the same index.
CREATE INDEX IF NOT EXISTS document_chunk_embeddings_cosine_hnsw_idx
  ON document_chunk_embeddings USING hnsw (embedding vector_cosine_ops);
