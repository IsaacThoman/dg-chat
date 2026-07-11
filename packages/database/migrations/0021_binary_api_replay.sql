ALTER TABLE api_idempotency_requests
  ADD COLUMN response_body_encoding text NOT NULL DEFAULT 'utf8'
  CONSTRAINT api_idempotency_requests_response_body_encoding_check
  CHECK (response_body_encoding IN ('utf8', 'base64'));

ALTER TABLE api_idempotency_requests
  DROP CONSTRAINT api_idempotency_requests_endpoint_check;

ALTER TABLE api_idempotency_requests
  ADD CONSTRAINT api_idempotency_requests_endpoint_check
  CHECK (endpoint IN (
    'chat.completions',
    'responses',
    'embeddings',
    'audio.transcriptions',
    'audio.translations',
    'audio.speech'
  ));
