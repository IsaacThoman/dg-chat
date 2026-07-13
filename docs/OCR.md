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
only a version and SHA-256 digest over the user, provider/model execution revisions, credential
update timestamp, prompt, and image inputs; source URLs, image bytes, prompts, user identifiers, and
credentials are never readable Redis key material. Per-user scoping prevents extracted text from
crossing account boundaries. Provider edits, credential replacement, model edits, and upstream-model
changes produce new keys, invalidating prior execution results without a Redis key scan. Writes use
Redis `SET ... EX` so the value and its TTL are installed atomically. The configured TTL remains
bounded to 1–2,592,000 seconds (30 days). The cache rejects values above 2 MB, while interception
applies the stricter 64 KiB usable-text limit above.

`OCR_CACHE_FAILURE_MODE` controls Redis outage behavior:

- `fail-open` (default) treats failed reads as misses and failed writes as no-ops. OCR remains
  available and the uncached provider call is billed normally.
- `fail-closed` rejects interception when Redis cannot be read or written. Use this when avoiding
  duplicate OCR provider calls is more important than availability.

Invalid failure-mode values stop API startup. In-memory development without `REDIS_URL` uses a
process-local TTL cache and does not provide cache sharing between replicas.

## Access-group policy

An OCR target is a privileged internal service dependency selected by an administrator. Model access
groups govern which models a user or token can select directly; they intentionally do not prevent a
configured source model from invoking its OCR target. Applying the caller's target-model entitlement
would make an otherwise available source model fail differently for each user and would expose
internal routing choices. The OCR child call remains linked to and billed to the caller, carries the
caller's cache isolation scope, and appears in provider-attempt and usage audit records. Disabling
an OCR target model or its provider is rejected until dependent source models are reconfigured,
including during backup restore.
