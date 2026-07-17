CREATE TABLE worker_instances (
  instance_id uuid PRIMARY KEY,
  worker_name varchar(128) NOT NULL,
  state varchar(16) NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  progress_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_stale_ms integer NOT NULL DEFAULT 20000,
  progress_stale_ms integer NOT NULL DEFAULT 180000,
  health_clock_tolerance_ms integer NOT NULL DEFAULT 5000,
  current_job_id uuid,
  current_job_type varchar(100),
  last_completed_at timestamptz,
  last_completed_job_id uuid,
  last_completed_job_type varchar(100),
  stopped_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT worker_instances_state_check
    CHECK (state IN ('starting','running','draining','stopped')),
  CONSTRAINT worker_instances_current_job_check
    CHECK ((current_job_id IS NULL) = (current_job_type IS NULL)),
  CONSTRAINT worker_instances_last_completed_job_check
    CHECK ((last_completed_job_id IS NULL) = (last_completed_job_type IS NULL)),
  CONSTRAINT worker_instances_last_completed_tuple_check
    CHECK ((last_completed_at IS NULL) = (last_completed_job_id IS NULL)),
  CONSTRAINT worker_instances_stopped_at_check
    CHECK ((state = 'stopped') = (stopped_at IS NOT NULL)),
  CONSTRAINT worker_instances_heartbeat_stale_check
    CHECK (heartbeat_stale_ms BETWEEN 1000 AND 300000),
  CONSTRAINT worker_instances_progress_stale_check
    CHECK (progress_stale_ms BETWEEN 1000 AND 3600000),
  CONSTRAINT worker_instances_clock_tolerance_check
    CHECK (health_clock_tolerance_ms BETWEEN 0 AND 60000)
);

CREATE INDEX worker_instances_freshness_idx
  ON worker_instances(state, heartbeat_at DESC, progress_at DESC);
CREATE INDEX worker_instances_name_started_idx
  ON worker_instances(worker_name, started_at DESC);

CREATE TRIGGER dg_chat_restore_maintenance_fence
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON worker_instances
  FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_restore_maintenance();
