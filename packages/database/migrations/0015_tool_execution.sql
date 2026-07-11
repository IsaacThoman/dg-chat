CREATE TABLE tool_policies (
  tool_id text PRIMARY KEY CHECK (tool_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  allowed boolean NOT NULL DEFAULT false,
  allowed_domains jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allowed_domains) = 'array'),
  allow_private_network boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tool_executions (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_id text NOT NULL CHECK (tool_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  input jsonb NOT NULL,
  status text NOT NULL CHECK (
    status IN ('pending_approval', 'queued', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  result jsonb,
  error jsonb,
  approved_at timestamptz,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  cancellation_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (result IS NULL OR status = 'succeeded'),
  CHECK (error IS NULL OR status = 'failed')
);

CREATE INDEX tool_executions_owner_updated_idx
  ON tool_executions(owner_id, updated_at DESC, id DESC);
CREATE INDEX tool_executions_active_idx
  ON tool_executions(status, updated_at)
  WHERE status IN ('queued', 'running');

