ALTER TABLE ledger_entries
  DROP CONSTRAINT IF EXISTS ledger_entries_usage_run_id_kind_key;
DROP INDEX IF EXISTS ledger_run_kind_uq;
CREATE INDEX IF NOT EXISTS ledger_run_kind_idx ON ledger_entries(usage_run_id, kind);
