-- Automatic retention runs are system-owned. Existing administrator-requested rows retain their
-- actor while scheduler-created rows deliberately use NULL.
ALTER TABLE retention_scrub_runs ALTER COLUMN requested_by DROP NOT NULL;

CREATE TABLE retention_schedule_state (
  singleton_id integer PRIMARY KEY DEFAULT 1 CHECK(singleton_id=1),
  interval_seconds integer NOT NULL DEFAULT 86400
    CHECK(interval_seconds BETWEEN 300 AND 2592000),
  next_due_at timestamptz NOT NULL DEFAULT now(),
  last_policy_version integer REFERENCES retention_policy_versions(version) ON DELETE RESTRICT,
  last_scheduled_at timestamptz,
  last_run_id uuid REFERENCES retention_scrub_runs(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retention_schedule_last_run_check CHECK(
    (last_run_id IS NULL AND last_scheduled_at IS NULL) OR
    (last_run_id IS NOT NULL AND last_scheduled_at IS NOT NULL))
);

INSERT INTO retention_schedule_state(singleton_id,interval_seconds,next_due_at)
VALUES(1,86400,now());

CREATE TRIGGER dg_chat_restore_maintenance_fence
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON retention_schedule_state
  FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_restore_maintenance();
