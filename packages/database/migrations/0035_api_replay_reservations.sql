ALTER TABLE api_idempotency_requests
  ADD COLUMN replay_reserved_bytes integer NOT NULL DEFAULT 0,
  ADD COLUMN replay_reserved_events integer NOT NULL DEFAULT 0;

ALTER TABLE api_idempotency_requests
  ADD CONSTRAINT api_idempotency_requests_replay_reservation_check
  CHECK (replay_reserved_bytes >= 0 AND replay_reserved_events >= 0);
