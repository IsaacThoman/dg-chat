CREATE TABLE retention_policy_versions (
  version integer PRIMARY KEY CHECK(version >= 1),
  capture_enabled boolean NOT NULL,
  request_body_days integer NOT NULL CHECK(request_body_days IN (1,7,14,30,90)),
  response_body_days integer NOT NULL CHECK(response_body_days IN (1,7,14,30,90)),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE RESTRICT
);
INSERT INTO retention_policy_versions(version,capture_enabled,request_body_days,response_body_days)
VALUES(1,false,30,30);
CREATE TABLE retention_policy_state (
  singleton_id integer PRIMARY KEY DEFAULT 1 CHECK(singleton_id=1),
  current_version integer NOT NULL REFERENCES retention_policy_versions(version) ON DELETE RESTRICT
);
INSERT INTO retention_policy_state(singleton_id,current_version) VALUES(1,1);

ALTER TABLE provider_attempts ADD CONSTRAINT provider_attempts_run_id_id_uq
  UNIQUE(usage_run_id,id);

CREATE TABLE provider_payload_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usage_run_id text NOT NULL REFERENCES usage_runs(id) ON DELETE RESTRICT,
  provider_attempt_id uuid NOT NULL,
  request_body text,
  response_body text,
  request_bytes integer NOT NULL DEFAULT 0 CHECK(request_bytes BETWEEN 0 AND 1048576),
  response_bytes integer NOT NULL DEFAULT 0 CHECK(response_bytes BETWEEN 0 AND 1048576),
  captured_at timestamptz NOT NULL DEFAULT now(),
  scrubbed_at timestamptz,
  CONSTRAINT provider_payload_captures_attempt_uq UNIQUE(provider_attempt_id),
  CONSTRAINT provider_payload_captures_attempt_run_fk FOREIGN KEY(usage_run_id,provider_attempt_id)
    REFERENCES provider_attempts(usage_run_id,id) ON DELETE RESTRICT,
  CONSTRAINT provider_payload_captures_body_check CHECK(
    request_body IS NOT NULL OR response_body IS NOT NULL OR scrubbed_at IS NOT NULL),
  CONSTRAINT provider_payload_captures_request_size_check CHECK(
    request_body IS NULL OR octet_length(request_body)=request_bytes),
  CONSTRAINT provider_payload_captures_response_size_check CHECK(
    response_body IS NULL OR octet_length(response_body)=response_bytes)
);
CREATE INDEX provider_payload_captures_request_scrub_idx
  ON provider_payload_captures(captured_at,id) WHERE request_body IS NOT NULL;
CREATE INDEX provider_payload_captures_response_scrub_idx
  ON provider_payload_captures(captured_at,id) WHERE response_body IS NOT NULL;

CREATE TABLE retention_scrub_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE CHECK(char_length(idempotency_key) BETWEEN 8 AND 200),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
  policy_version integer NOT NULL REFERENCES retention_policy_versions(version) ON DELETE RESTRICT,
  capture_enabled boolean NOT NULL,
  request_body_days integer NOT NULL CHECK(request_body_days IN (1,7,14,30,90)),
  response_body_days integer NOT NULL CHECK(response_body_days IN (1,7,14,30,90)),
  request_cutoff_at timestamptz NOT NULL,
  response_cutoff_at timestamptz NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  captures_scrubbed integer NOT NULL DEFAULT 0 CHECK(captures_scrubbed >= 0),
  request_bodies_scrubbed integer NOT NULL DEFAULT 0 CHECK(request_bodies_scrubbed >= 0),
  response_bodies_scrubbed integer NOT NULL DEFAULT 0 CHECK(response_bodies_scrubbed >= 0),
  bytes_scrubbed bigint NOT NULL DEFAULT 0 CHECK(bytes_scrubbed >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error text CHECK(error IS NULL OR char_length(error) <= 1000),
  CONSTRAINT retention_scrub_runs_cutoff_check CHECK(
    request_cutoff_at <= created_at AND response_cutoff_at <= created_at),
  CONSTRAINT retention_scrub_runs_terminal_check CHECK(
    (status IN ('queued','running') AND completed_at IS NULL AND error IS NULL) OR
    (status='completed' AND completed_at IS NOT NULL AND error IS NULL) OR
    (status='failed' AND completed_at IS NOT NULL AND error IS NOT NULL))
);
CREATE INDEX retention_scrub_runs_status_created_idx
  ON retention_scrub_runs(status,created_at,id);
