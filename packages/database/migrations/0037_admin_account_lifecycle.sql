-- Account activation and soft deletion are independent lifecycle dimensions. Preserve the
-- historical enum label for PostgreSQL compatibility, but normalize every legacy row and prevent
-- future writes from using it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

UPDATE users
SET deleted_at = COALESCE(deleted_at, updated_at, created_at, now()),
    state = 'suspended',
    updated_at = COALESCE(updated_at, created_at, now())
WHERE state = 'deleted';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'users'::regclass AND conname = 'users_version_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_version_check CHECK(version >= 1);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'users'::regclass AND conname = 'users_account_state_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_account_state_check
      CHECK(state IN ('active','suspended'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS users_created_cursor_idx ON users(created_at DESC,id DESC);
