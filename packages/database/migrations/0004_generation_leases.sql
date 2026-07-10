ALTER TABLE usage_runs
  ADD COLUMN generation_lease_token uuid,
  ADD COLUMN generation_lease_expires_at timestamptz;

ALTER TABLE usage_runs ADD CONSTRAINT usage_runs_generation_lease_check
  CHECK (
    (generation_lease_token IS NULL AND generation_lease_expires_at IS NULL) OR
    (status = 'reserved' AND generation_lease_token IS NOT NULL AND generation_lease_expires_at IS NOT NULL)
  );

CREATE INDEX usage_runs_generation_lease_idx
  ON usage_runs(generation_lease_expires_at)
  WHERE status = 'reserved' AND generation_lease_token IS NOT NULL;
