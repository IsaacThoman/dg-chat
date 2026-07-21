# OpenAI API compatibility

DG Chat exposes OpenAI-shaped endpoints under `/v1`. Authenticate with a personal API token:

```sh
curl http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer $DG_CHAT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"provider/model","messages":[{"role":"user","content":"Hello"}]}'
```

The implemented surface is models, chat completions, Responses, embeddings, audio transcription,
audio translation, speech synthesis, image generation, and the Files lifecycle. Simulated and
configured upstream chat streams use validated SSE and terminate with exactly one `[DONE]`. Files
support upload, list, retrieve, content, and delete through the official JavaScript and Python
clients. Uploads currently accept only the `assistants` purpose. List responses implement stable
cursor pagination through the official clients' `after` and `limit` parameters. Embeddings use
admin-configured models with the `embeddings` capability, preserve input ordering and float/base64
formats, participate in provider fallback and circuit breaking, and are credit-metered and
idempotent. Transcription and translation accept bounded, signature-validated multipart audio,
support JSON, diarized JSON, verbose JSON, text, SRT, and VTT response formats, and use capable
provider-registry models with the same retry, fallback, circuit-breaker, accounting, cancellation,
and durable replay behavior. Transcriptions also preserve OpenAI-compatible `include[]=logprobs`,
automatic or bounded server-VAD chunking, known-speaker references, and validated SSE delta/done
streams. Speech synthesis supports MP3, Opus, AAC, FLAC, WAV, and PCM, custom voice references,
instructions, speed control, byte-exact binary replay, and canonical
`speech.audio.delta`/`speech.audio.done` SSE. Speech models currently require fixed-call-only
pricing because raw binary responses do not carry portable usage metadata. Streaming retries and
fallback remain available until the first visible audio or transcript event; provider usage is
extracted from terminal events. Image generation supports strict OpenAI-compatible JSON, base64
PNG/JPEG/WebP outputs, immutable object-storage-backed history, and exact idempotent replay. Image
editing accepts official multipart image arrays and owned JSON file references, including canonical
`image_edit.*` streams. Edits require an explicit `model`: OpenAI permits a hosted default, but a
self-hosted installation can expose multiple unrelated providers and has no unambiguous global
default. Omission returns HTTP 422 with `model_required`. Image models require fixed-call-only
pricing when their provider supplies no authoritative token usage. Assistants, batches, fine-tuning,
and realtime are not supported.

### Deliberate compatibility boundaries

The Responses endpoint is currently stateless. Clients can continue a response by sending the prior
output items back in `input`, including reasoning and function-call items, but `store: true`,
`previous_response_id`, non-empty `include`, and `background: true` are rejected before provider
dispatch. In particular, `include: ["reasoning.encrypted_content"]` is not yet available. Response
objects report `store: false` and `previous_response_id: null` so they never imply that server-side
continuation exists.

Files currently accept and report only the `assistants` purpose. Upload, list, retrieve, content,
and delete are owner-scoped. File upload accepts an optional `Idempotency-Key`, replays the exact
completed File object for identical content and metadata, and rejects changed payloads. Image
generation and editing support exact idempotent replay for base64 responses and streams; expiring
`response_format: "url"` responses reject `Idempotency-Key` rather than returning a replay that
could expire between attempts.

Chat Completions currently supports one choice (`n` omitted or `n: 1`). When a Chat request targets
a native Responses provider, parameters that cannot be translated losslessly—currently `stop`,
`frequency_penalty`, `presence_penalty`, `seed`, and multiple choices—return a structured
unsupported-feature error instead of being silently discarded.

Audio pricing supports token-reported usage and fixed per-call charges. Duration-only usage is
accepted only for models configured with fixed-call-only pricing; mixing duration usage with token
rates fails closed until duration-based price versions are added to the accounting schema. Responses
without usage use clearly marked conservative estimates derived from uploaded/prompt bytes and
validated transcript text.

Except for the expiring-image-URL boundary above, use a unique `Idempotency-Key` for each mutation
request. Keys are scoped to the authenticated user and endpoint. Chat, Responses, embeddings, file
uploads, image base64/stream, and audio endpoints replay a completed response for an identical
logical request and reject the same key with changed input. Audio and file identity use validated
content and metadata rather than multipart boundary bytes. Client disconnects cancel upstream work
where possible, and requests reserve a conservative maximum before provider work begins.

Every API token consumes a fixed 60-second rotation-family quota, including tokens that inherit the
deployment default. Rotation therefore does not reset the effective RPM budget. Every token also
consumes a fixed one-second family bucket, using its explicit override or
`TOKEN_DEFAULT_BURST_LIMIT` (20 by default). Responses expose the most restrictive applicable
`X-RateLimit-Limit` and `X-RateLimit-Remaining`; denied requests use the controlling bucket's
`Retry-After`. The separate pre-auth credential/deployment limiter remains in place to reject
abusive traffic before token verification.

The provider-qualified model ID is the stable identifier. Admin aliases may point at it, but clients
should not assume every model supports tools, vision, reasoning, images, or audio; inspect model
capability metadata or handle a structured unsupported-capability error.

The built-in `simulated/*` and legacy `OPENAI_*` models exist only in the nonproduction test
harness. Production catalogs and invocation are registry-only: every model and alias therefore
passes through the same access-group entitlement checks. To expose deterministic simulator behavior
in production, register an internal provider/model with explicit pricing and assign it through
normal access groups.
