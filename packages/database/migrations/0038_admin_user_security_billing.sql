-- Keep every bigint crossing the TypeScript boundary exactly representable. Existing non-negative
-- checks remain in place; these named constraints add the upper bound and cover ledger deltas.
ALTER TABLE users ADD CONSTRAINT users_balance_safe_check
  CHECK(balance_micros BETWEEN 0 AND 9007199254740991);

ALTER TABLE ledger_entries ADD CONSTRAINT ledger_amount_safe_check
  CHECK(amount_micros BETWEEN -9007199254740991 AND 9007199254740991);

ALTER TABLE ledger_entries ADD CONSTRAINT ledger_balance_safe_check
  CHECK(balance_after_micros BETWEEN 0 AND 9007199254740991);

CREATE INDEX ledger_user_page_idx
  ON ledger_entries(user_id,created_at DESC,id DESC);
CREATE INDEX auth_sessions_user_page_idx
  ON auth_sessions(user_id,created_at DESC,id DESC);
CREATE INDEX sessions_user_page_idx
  ON sessions(user_id,created_at DESC,id DESC);
CREATE INDEX api_tokens_user_page_idx
  ON api_tokens(user_id,created_at DESC,id DESC);

-- A dedicated command record supplies exact replay semantics without restoring the global
-- (usage_run_id,kind) uniqueness intentionally removed by migration 0016.
CREATE TABLE admin_balance_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key_hash text NOT NULL,
  request_hash text NOT NULL,
  amount_micros bigint NOT NULL,
  balance_before_micros bigint NOT NULL,
  balance_after_micros bigint NOT NULL,
  reason text NOT NULL,
  ledger_entry_id uuid NOT NULL REFERENCES ledger_entries(id) ON DELETE RESTRICT,
  audit_event_id uuid NOT NULL REFERENCES audit_events(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_balance_adjustments_actor_key_uq
    UNIQUE(actor_id,idempotency_key_hash),
  CONSTRAINT admin_balance_adjustments_ledger_entry_uq UNIQUE(ledger_entry_id),
  CONSTRAINT admin_balance_adjustments_audit_event_uq UNIQUE(audit_event_id),
  CONSTRAINT admin_balance_adjustments_key_hash_check
    CHECK(idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT admin_balance_adjustments_request_hash_check
    CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT admin_balance_adjustments_amount_check
    CHECK(amount_micros BETWEEN -9007199254740991 AND 9007199254740991 AND amount_micros <> 0),
  CONSTRAINT admin_balance_adjustments_balance_check
    CHECK(
      balance_before_micros BETWEEN 0 AND 9007199254740991
      AND balance_after_micros BETWEEN 0 AND 9007199254740991
      AND balance_after_micros = balance_before_micros + amount_micros
    ),
  CONSTRAINT admin_balance_adjustments_reason_check
    CHECK(reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 500)
);

CREATE INDEX admin_balance_adjustments_target_page_idx
  ON admin_balance_adjustments(target_user_id,created_at DESC,id DESC);
CREATE INDEX admin_balance_adjustments_actor_page_idx
  ON admin_balance_adjustments(actor_id,created_at DESC,id DESC);

CREATE TRIGGER dg_chat_restore_maintenance_fence
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON admin_balance_adjustments
  FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_restore_maintenance();
