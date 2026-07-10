CREATE EXTENSION IF NOT EXISTS vector;
CREATE TYPE approval_status AS ENUM ('pending','approved','rejected');
CREATE TYPE user_role AS ENUM ('user','admin');
CREATE TYPE account_state AS ENUM ('active','suspended','deleted');
CREATE TYPE message_role AS ENUM ('system','user','assistant','tool');
CREATE TYPE message_status AS ENUM ('complete','streaming','stopped','error','tombstoned');
CREATE TYPE ledger_kind AS ENUM ('grant','reserve','settle','refund','adjustment');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE, name text NOT NULL,
  password_hash text NOT NULL, role user_role NOT NULL DEFAULT 'user', approval_status approval_status NOT NULL DEFAULT 'pending',
  state account_state NOT NULL DEFAULT 'active', balance_micros bigint NOT NULL DEFAULT 0 CHECK (balance_micros >= 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, limited boolean NOT NULL DEFAULT false, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), invalidated_at timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL, active_leaf_id uuid, version integer NOT NULL DEFAULT 0, pinned boolean NOT NULL DEFAULT false,
  temporary boolean NOT NULL DEFAULT false, archived_at timestamptz, deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_owner_updated_idx ON conversations(owner_id, updated_at DESC);
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES messages(id), supersedes_id uuid REFERENCES messages(id), generation_id uuid,
  sibling_index integer NOT NULL CHECK (sibling_index >= 0), role message_role NOT NULL, content text NOT NULL,
  model text, status message_status NOT NULL DEFAULT 'complete', metadata jsonb NOT NULL DEFAULT '{}',
  idempotency_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation_id, idempotency_key), UNIQUE(conversation_id, parent_id, sibling_index)
);
CREATE INDEX messages_parent_idx ON messages(parent_id);
ALTER TABLE conversations ADD CONSTRAINT conversations_active_leaf_fk FOREIGN KEY(active_leaf_id) REFERENCES messages(id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id), object_key text NOT NULL UNIQUE,
  filename text NOT NULL, mime_type text NOT NULL, size_bytes bigint NOT NULL CHECK(size_bytes >= 0), sha256 text NOT NULL,
  state text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id, sha256)
);
CREATE TABLE message_attachments (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE, attachment_id uuid NOT NULL REFERENCES attachments(id),
  PRIMARY KEY(message_id, attachment_id)
);
CREATE TABLE api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL, token_hash text NOT NULL UNIQUE, preview text NOT NULL, scopes jsonb NOT NULL,
  expires_at timestamptz, revoked_at timestamptz, last_used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_tokens_user_idx ON api_tokens(user_id);
CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), usage_run_id text NOT NULL,
  kind ledger_kind NOT NULL, amount_micros bigint NOT NULL, balance_after_micros bigint NOT NULL CHECK(balance_after_micros >= 0),
  metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(usage_run_id, kind)
);
CREATE INDEX ledger_user_idx ON ledger_entries(user_id);
CREATE TABLE usage_runs (
  id text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), token_id uuid REFERENCES api_tokens(id), model text NOT NULL,
  provider text NOT NULL, status text NOT NULL, input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0,
  cost_micros bigint NOT NULL DEFAULT 0, latency_ms integer, ttft_ms integer, error text,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text NOT NULL, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), locked_at timestamptz,
  locked_by text, last_error text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE INDEX jobs_claim_idx ON jobs(status, available_at);
CREATE TABLE document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), attachment_id uuid NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  ordinal integer NOT NULL, content text NOT NULL, embedding vector(1536), metadata jsonb NOT NULL DEFAULT '{}', UNIQUE(attachment_id, ordinal)
);
CREATE INDEX document_chunks_embedding_idx ON document_chunks USING hnsw (embedding vector_cosine_ops);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid REFERENCES users(id), action text NOT NULL,
  target_type text NOT NULL, target_id text, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_created_idx ON audit_events(created_at DESC);

-- The API's lightweight durable adapter checkpoints its complete domain state here. The normalized
-- tables above remain the migration target for the full transactional repository.
CREATE TABLE runtime_snapshots (
  id text PRIMARY KEY, payload jsonb NOT NULL, revision bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);
