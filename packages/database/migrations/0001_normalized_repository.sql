-- Upgrade installations created before normalized transactional persistence was introduced.
CREATE TABLE IF NOT EXISTS repository_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS operation_idempotency (
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  result_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, operation, idempotency_key)
);

ALTER TABLE usage_runs
  ADD COLUMN IF NOT EXISTS reserved_micros bigint NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usage_runs_status_check') THEN
    ALTER TABLE usage_runs ADD CONSTRAINT usage_runs_status_check
      CHECK(status IN ('reserved','completed','failed'));
  END IF;
END $$;

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_active_leaf_fk;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_parent_id_fkey;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_supersedes_id_fkey;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_conversation_id_parent_id_sibling_index_key;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_id_conversation_uq') THEN
    ALTER TABLE messages ADD CONSTRAINT messages_id_conversation_uq UNIQUE(id, conversation_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_sibling_uq') THEN
    ALTER TABLE messages ADD CONSTRAINT messages_sibling_uq
      UNIQUE NULLS NOT DISTINCT(conversation_id, parent_id, sibling_index);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_parent_conversation_fk') THEN
    ALTER TABLE messages ADD CONSTRAINT messages_parent_conversation_fk
      FOREIGN KEY(parent_id, conversation_id) REFERENCES messages(id, conversation_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_supersedes_conversation_fk') THEN
    ALTER TABLE messages ADD CONSTRAINT messages_supersedes_conversation_fk
      FOREIGN KEY(supersedes_id, conversation_id) REFERENCES messages(id, conversation_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

ALTER TABLE conversations ADD CONSTRAINT conversations_active_leaf_fk
  FOREIGN KEY(active_leaf_id, id) REFERENCES messages(id, conversation_id)
  DEFERRABLE INITIALLY DEFERRED;
