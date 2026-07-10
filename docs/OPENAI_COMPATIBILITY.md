# OpenAI API compatibility

DG Chat exposes OpenAI-shaped endpoints under `/v1`. Authenticate with a personal API token:

```sh
curl http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer $DG_CHAT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"provider/model","messages":[{"role":"user","content":"Hello"}]}'
```

The implemented surface is models, chat completions, and non-streaming Responses. Simulated-model
chat streams use SSE and terminate with `[DONE]`; configured upstream calls currently use
non-streaming passthrough. Embeddings, files, images, and audio routes return explicit OpenAI-shaped
`501 provider_not_configured` responses until their adapters are configured in a later milestone.
Assistants, batches, fine-tuning, and realtime are not supported.

Use a unique `Idempotency-Key` for each request. Keys are scoped to the authenticated user and
endpoint; this release rejects reuse instead of replaying a cached response. Client disconnects
cancel upstream work where possible, and requests reserve a conservative maximum before provider
work begins.

The provider-qualified model ID is the stable identifier. Admin aliases may point at it, but clients
should not assume every model supports tools, vision, reasoning, images, or audio; inspect model
capability metadata or handle a structured unsupported-capability error.
