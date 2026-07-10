ALTER TABLE api_idempotency_requests
  DROP CONSTRAINT api_idempotency_requests_endpoint_check;

ALTER TABLE api_idempotency_requests
  ADD CONSTRAINT api_idempotency_requests_endpoint_check
  CHECK (endpoint IN ('chat.completions', 'responses', 'embeddings'));
