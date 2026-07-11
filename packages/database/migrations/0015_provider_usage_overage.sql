ALTER TABLE usage_runs
  ADD COLUMN uncovered_cost_micros bigint NOT NULL DEFAULT 0
    CHECK (uncovered_cost_micros BETWEEN 0 AND 9007199254740991);

ALTER TABLE usage_runs ADD CONSTRAINT usage_runs_uncovered_cost_check CHECK (
  uncovered_cost_micros <= cost_micros AND
  (uncovered_cost_micros = 0 OR (status = 'failed' AND error = 'provider_usage_overage'))
);
