CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Literal, case-insensitive search still benefits from trigram candidate indexes for longer terms.
-- Every application query additionally starts from an owner-scoped conversation set.
-- Drizzle applies this migration transactionally, which rules out CREATE INDEX CONCURRENTLY.
-- Fail quickly if an operator has not drained writers for the documented maintenance window
-- instead of waiting behind an unbounded application transaction while holding migration state.
SET lock_timeout = '5s';
CREATE INDEX conversations_title_trgm_idx
  ON conversations USING gin (lower(title) gin_trgm_ops);
CREATE INDEX messages_search_content_trgm_idx
  ON messages USING gin (lower(CASE
    WHEN role='user' AND jsonb_typeof(metadata->'authoredContent')='string'
      THEN metadata->>'authoredContent'
    ELSE content
  END) gin_trgm_ops)
  WHERE role IN ('user','assistant') AND status <> 'tombstoned';
CREATE INDEX conversations_owner_lifecycle_search_idx
  ON conversations(owner_id,deleted_at,archived_at,updated_at DESC,id DESC);
RESET lock_timeout;
