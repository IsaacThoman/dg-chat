# OpenAI API compatibility

DG Chat exposes OpenAI-shaped endpoints under `/v1`. Authenticate with a personal API token:

```sh
curl http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer $DG_CHAT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"provider/model","messages":[{"role":"user","content":"Hello"}]}'
```

The implemented surface is models, chat completions, Responses, embeddings, audio transcription,
audio translation, and the Files lifecycle. Simulated-model chat streams use SSE and terminate with
`[DONE]`; configured upstream calls currently use non-streaming passthrough. Files support upload,
list, retrieve, content, and delete through the official JavaScript and Python clients. Uploads
currently accept only the `assistants` purpose, and list responses do not yet implement cursor
pagination. Embeddings use admin-configured models with the `embeddings` capability, preserve input
ordering and float/base64 formats, participate in provider fallback and circuit breaking, and are
credit-metered and idempotent. Transcription and translation accept bounded, signature-validated
multipart audio, support JSON, diarized JSON, verbose JSON, text, SRT, and VTT response formats, and
use capable provider-registry models with the same retry, fallback, circuit-breaker, accounting,
cancellation, and durable replay behavior. Transcriptions also preserve OpenAI-compatible
`include[]=logprobs`, automatic or bounded server-VAD chunking, known-speaker references, and
validated SSE delta/done streams. Streaming retries and fallback remain available until the first
visible transcript event; provider usage is extracted from the terminal event. Image generation and
speech synthesis still return explicit OpenAI-shaped `501 provider_not_configured` responses.
Assistants, batches, fine-tuning, and realtime are not supported.

Audio pricing supports token-reported usage and fixed per-call charges. Duration-only usage is
accepted only for models configured with fixed-call-only pricing; mixing duration usage with token
rates fails closed until duration-based price versions are added to the accounting schema. Responses
without usage use clearly marked conservative estimates derived from uploaded/prompt bytes and
validated transcript text.

Use a unique `Idempotency-Key` for each request. Keys are scoped to the authenticated user and
endpoint. Embeddings and audio replay a completed response for an identical logical request and
reject the same key with changed input. Audio identity uses the validated file digest rather than a
multipart boundary or filename. Client disconnects cancel upstream work where possible, and requests
reserve a conservative maximum before provider work begins.

The provider-qualified model ID is the stable identifier. Admin aliases may point at it, but clients
should not assume every model supports tools, vision, reasoning, images, or audio; inspect model
capability metadata or handle a structured unsupported-capability error.
