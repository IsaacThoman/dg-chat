CREATE TABLE generation_controls (
  run_id text PRIMARY KEY REFERENCES usage_runs(id) ON DELETE CASCADE,
  generation_id uuid NOT NULL UNIQUE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'send' CHECK (mode IN ('send','regenerate','continue')),
  source_message_id uuid REFERENCES messages(id) ON DELETE RESTRICT,
  stop_requested_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX generation_controls_owner_idx
  ON generation_controls(owner_id, conversation_id);
CREATE UNIQUE INDEX generation_controls_active_source_uq
  ON generation_controls(conversation_id, source_message_id)
  WHERE terminal_at IS NULL AND source_message_id IS NOT NULL;
CREATE UNIQUE INDEX generation_controls_active_conversation_uq
  ON generation_controls(conversation_id)
  WHERE terminal_at IS NULL;
