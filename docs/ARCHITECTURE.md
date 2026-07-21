# Architecture

DG Chat is a single-installation, multi-user system. The web client and OpenAI-compatible API share
an application gateway, but use separate contracts: browser features live under `/api/*`;
compatibility endpoints live under `/v1/*`.

## Target runtime topology

The Compose stack provisions the full dependency topology. PostgreSQL is authoritative for the
normalized domain model, durable jobs, accounting, and OpenAI replay state. Redis is on the request
path for distributed rate limits and shared provider circuit breakers. MinIO provides the default
S3-compatible private object store for uploads, OpenAI Files, and ingestion jobs.

```mermaid
flowchart LR
  Browser[React web client] --> App[Deno + Hono application]
  SDK[OpenAI SDK] --> App
  App --> PG[(PostgreSQL + pgvector)]
  App --> Redis[(Redis)]
  App --> S3[(S3 / MinIO)]
  App --> Provider[OpenAI-compatible providers]
  Worker[Deno worker] --> PG
  Worker --> Redis
  Worker --> S3
  Worker --> Provider
```

- PostgreSQL is authoritative for identity, immutable conversations, accounting, durable jobs,
  configuration, and audit records.
- Redis currently contains disposable rate-limit windows and shared provider circuit-breaker state.
  Presence and ephemeral stream coordination remain planned; correctness must not depend on Redis
  persistence.
- S3-compatible storage owns immutable upload objects. Browser attachment routes and the
  OpenAI-compatible Files lifecycle stream uploads into private objects and authorize every read by
  owner or immutable historical message link. Attachment deletion is a logical tombstone so edits
  cannot break an earlier conversation branch. Durable upload staging reconciles interrupted writes,
  and generated-object cleanup uses row-locked reference fences plus append-only release settlement
  after physical deletion. General retention-policy-driven deletion remains planned.
- The worker claims durable jobs using `FOR UPDATE SKIP LOCKED`. Handlers must be idempotent and
  retry-safe. Text and JSON attachments use a separate, fenced ingestion state machine that streams
  private objects through byte/time and format validation, then transactionally replaces stable,
  citation-aware chunks. One absolute deadline spans object acquisition, extraction, and chunking,
  leaves a safety margin before lease expiry, and runs PDF/DOCX parsers in a terminable worker
  isolate. Text and JSON use strict UTF-8 parsing; PDF extraction is page-bounded and DOCX
  extraction rejects unsafe archives, macros, encryption, traversal, excessive expansion, and
  external relationships before decompression. Chunk and extractor versions are persisted with page
  or section provenance. Conversation-bound collections support hybrid lexical/vector retrieval or
  bounded full-context injection with persisted source provenance. The OpenAI-compatible embeddings
  endpoint and durable pgvector indexing are implemented for capable provider-registry models. OCR
  interception is implemented with bounded image fetching and a hashed TTL cache. Administrative
  attachment reinspection increments a policy epoch and enters the same durable worker boundary;
  stale jobs cannot overwrite newer policy decisions and there is no manual release bypass. A
  disabled-by-default authenticated external scanner integration supplies malware verdicts when
  configured; the built-in pass verifies the stored digest and detects the EICAR test marker, while
  the external path uses exact-host allowlisting, one pinned DNS resolution, manual redirect
  rejection, bounded streaming/time/response limits, and sanitized failures. Scanner requirements
  and the policy version are persisted with each upload so split API/worker configuration fails
  closed. Other Office formats remain planned.

## Core invariants

Messages form a directed acyclic graph. Editing or regenerating appends a node and changes the
user's active leaf transactionally; it never mutates the earlier node. `parent_id` establishes the
path, `supersedes_id` describes edit intent, and a conversation version prevents lost concurrent
updates. Tombstones are explicit nodes/state, not destructive deletion.

Credits use an append-only ledger. A request reserves funds before provider work and settles or
refunds exactly once using an idempotency key. Derived balances are cacheable, while ledger entries
remain authoritative.

API token plaintext is shown once. Only a cryptographic hash, a short preview, scope metadata, and
usage timestamps persist. Admin-managed provider credentials use per-version envelope encryption;
the API decrypts them only while resolving an enabled, effectively priced runtime model. Provider,
model, credential, and append-only price mutations use optimistic versions and atomic audit writes.
Usage reservations snapshot the exact effective price version and all rate categories so later
administrative price changes cannot rewrite historical accounting.

Optional provider diagnostics live outside conversations and accounting records. The current
versioned retention policy is locked while a capture is admitted; scrub previews return exact
request and response cutoff timestamps, and enqueue persists those same timestamps under an
idempotency key. Bounded `SKIP LOCKED` worker batches only null diagnostic bodies and record
terminal audit events, so a policy change or retry cannot expand a previously reviewed deletion
boundary.

## Trust boundaries

All browser input, uploaded content, provider output, tool calls, and fetched URLs are untrusted.
Authorization is evaluated on every object read, not only when signed URLs are created. Search
adapters are trusted in-process application code: their `networkTarget` metadata supports policy
checks but is advisory and cannot sandbox a custom adapter. The built-in SearXNG adapter's
DNS-resolved, address-pinned, no-redirect transport is the actual SSRF enforcement boundary and
rejects private, loopback, link-local, and metadata-network destinations. Custom adapters must
provide an equivalent transport boundary. Optional code execution is a separate, authenticated
service with no default network, read-only inputs, strict resources, and no Docker socket.

## Availability and observability

`/health` reports process liveness; `/ready` verifies required dependencies. Deployments should
remove an instance from service when readiness fails without restarting it solely for a transient
provider outage. HTTP request logs carry a server-generated request ID and a registered route
template while excluding raw URLs, queries, headers, identities, secrets, and prompt bodies. Durable
usage runs and provider attempts retain their own relational correlation. The API and worker expose
separate Prometheus listeners on the private deployment network with closed, low-cardinality label
sets. A manual OpenTelemetry SDK supplies W3C trace-context extraction and batched OTLP export when
enabled. API spans contain only bounded method/route attributes; worker job spans contain only a
bounded job-type attribute. Exception text is never attached. Deno's native auto-instrumentation is
explicitly disabled because its exported attribute list retains the original `url.full`, `url.path`,
and `url.query`, even if application code adds redacted replacements. This prevents conversation
identifiers, share capabilities, signed URLs, and query content from entering traces.

See [SECURITY.md](SECURITY.md) for controls and [DEPLOYMENT.md](DEPLOYMENT.md) for the production
topology.
