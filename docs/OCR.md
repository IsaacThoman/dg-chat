# OCR interception operations

Model-level OCR interception replaces supported image parts with extracted text before the primary
chat provider is called. Each uncached OCR call creates its own credit reservation and usage run,
persists its provider attempts, and settles or refunds independently of the parent chat run. A cache
hit does not create a provider call or usage charge.

OCR provider requests are capped at 4,096 output tokens and usable extracted text is limited to 64
KiB. After images are rewritten, the parent chat reservation is atomically raised to cover the
expanded prompt before the chat provider can be dispatched. Concurrent extensions serialize on the
usage run; insufficient remaining credit stops chat dispatch.

When `REDIS_URL` is configured, API replicas share OCR results through Redis. Cache keys contain
only a version and SHA-256 digest over the provider/model/prompt/image inputs; source URLs, image
bytes, prompts, and credentials are never Redis key material. Writes use Redis `SET ... EX` so the
value and its TTL are installed atomically. The configured TTL remains bounded to 1–2,592,000
seconds (30 days). The cache rejects values above 2 MB, while interception applies the stricter 64
KiB usable-text limit above.

`OCR_CACHE_FAILURE_MODE` controls Redis outage behavior:

- `fail-open` (default) treats failed reads as misses and failed writes as no-ops. OCR remains
  available and the uncached provider call is billed normally.
- `fail-closed` rejects interception when Redis cannot be read or written. Use this when avoiding
  duplicate OCR provider calls is more important than availability.

Invalid failure-mode values stop API startup. In-memory development without `REDIS_URL` uses a
process-local TTL cache and does not provide cache sharing between replicas.
