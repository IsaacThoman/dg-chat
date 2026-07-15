# Security

## Deployment checklist

- Terminate modern TLS at a trusted proxy; set exact public origins and trusted-proxy ranges.
- Rotate `SETUP_TOKEN` immediately after bootstrap. Never expose it to the browser bundle.
- Generate independent application, encryption, database, storage, SMTP, and OIDC secrets.
- Keep PostgreSQL, Redis, MinIO, and worker ports off the public network.
- Run containers without privilege escalation, writable root filesystems, or the Docker socket.
- Put registration behind an abuse-resistant reverse proxy until distributed rate limiting and email
  verification are enabled.
- Set upload byte, pixel, archive-expansion, processing-time, and per-user quota limits.
- Keep payload retention disabled unless explicitly required; scrub content on schedule.
- Back up the encryption keyring separately and test restore before production use.

## Application controls

Sessions use secure, HTTP-only, same-site cookies in production. State-changing cookie-authenticated
requests enforce an exact Origin when one is present. Approval, role, suspension, and deletion are
independent states; suspension invalidates sessions and API tokens. The final active approved
administrator cannot be rejected, suspended, or deleted. Redis-backed distributed rate limiting,
hash-only one-time email verification and password-reset tokens, transactional credential
invalidation, session revocation, and immutable identity audit events are enforced. Email
verification is opt-in with `REQUIRE_EMAIL_VERIFICATION=true`; leave it false for approval-only
registration without SMTP. When verification is required, configure SMTP before exposing
registration. Generic OIDC is available only when its issuer, client credentials, callback origin,
and scopes are configured explicitly; callback state, nonce, PKCE, and origin checks fail closed.
HTTP request logs use registered route templates and server-generated UUID request IDs rather than
raw URLs. Caller-supplied correlation IDs are ignored to prevent cross-request collision. Query
strings, headers, path capabilities, user search values, OIDC codes/state, and exception details are
never included; the request ID returned and CORS-exposed in `X-Request-Id` correlates sanitized
failures. Better Auth warnings and errors are reduced to a fixed component/severity event; callback
parameters, identity values, and adapter exception details are never forwarded to application logs.

Markdown, citations, filenames, provider errors, and tool results are rendered as hostile content
under a restrictive Content Security Policy. Raw HTML is disabled unless passed through a maintained
sanitizer. Spreadsheet formulas are escaped in CSV exports. Mermaid and artifact rendering are not
currently exposed by the product.

File upload routes stream multipart bodies through byte and concurrency limits, MIME sniffing,
filename normalization, immutable object keys, ownership checks, and image dimension/decompression
guards. Objects are private in S3-compatible storage; direct reads require ownership, while
tombstoned objects remain available only through an immutable historical message link. PNG and JPEG
files receive a bounded full decode before becoming ready. GIF and WebP files remain quarantined
because a trusted full decoder is not yet configured.

The current attachment worker acknowledges terminal inspection states; it is not an antivirus or
content-disarm scanner. Audio acceptance still relies on bounded upload handling and MIME/signature
checks, so deployments requiring malware scanning must add an external quarantine scanner. Bounded,
strict UTF-8 ingestion is implemented for `text/plain` and fully validated JSON. PDF extraction has
raw-byte, page-count, and output limits. PDF and DOCX parsing runs in a terminable worker isolate
under one absolute, lease-margined job deadline. DOCX extraction preflights the ZIP directory and
rejects ZIP64/multidisk archives, traversal, encryption, macros, external relationships, excessive
entries, per-entry size, aggregate expansion, and suspicious compression ratios before extraction.
Other Office formats, object garbage collection, and retention-aware deletion are not implemented.
OCR interception, PostgreSQL vector persistence, and hybrid lexical/vector retrieval are implemented
with bounded inputs, owner scoping, cache keys derived from content hashes, and durable accounting.
Embeddings and audio provider calls use the same DNS-pinned, private-network-blocking transport and
strict bounded response validation as chat providers.

The current OpenAI-compatible provider transport resolves every A and AAAA answer, rejects
special-use destinations, and pins the approved address while preserving TLS hostname validation. It
rejects redirects and bounds response and streaming bytes. OCR, SearXNG search, approved tools, and
ingestion each enforce their own network, redirect, byte, MIME, and relevant image/archive limits.
Any future sandbox fetcher must preserve those controls independently.

## Secrets and privacy

API token plaintext is revealed once and never logged; only its SHA-256 hash and preview persist.
Provider credentials use randomized per-credential AES-256-GCM data keys wrapped by an
environment-supplied keyring. Envelopes are bound to the provider and credential version, public
admin responses expose only credential presence/update time, and plaintext is never revealed after
replacement. Provider discovery reuses the DNS-pinned, HTTPS-only, no-redirect transport and stores
only bounded failure categories.

Provider request and response diagnostics are disabled by default. When an administrator opts in,
captures are separately stored, limited to one MiB per side, linked to the immutable usage run and
provider attempt, and conservatively redact credential-bearing keys, URLs, signed queries, encoded
media, and normalized provider errors. Retention previews expose aggregate counts and exact cutoff
timestamps only. A scrub run is fenced to those reviewed cutoffs and permanently nulls eligible
diagnostic bodies while preserving chats, attachments, usage, costs, attempts, and audit history.
Worker failures persist fixed public codes and messages rather than exception text.

Conversations remain private unless their owner explicitly creates a read-only snapshot pinned to an
exact immutable leaf. Share capabilities are generated in the browser, revealed once, and stored
only as SHA-256 hashes. Public snapshots use share-local message and attachment identifiers, omit
system/developer and tombstoned content, hide provider routing, default to anonymous identity with
attachments redacted, and never follow later edits. Public responses are `no-store`/`no-referrer`,
and access fails closed after revocation, expiry, owner suspension, or owner deletion. The public
attachment route revalidates the live share, object ownership, MIME type, and byte length on every
read.

## Reporting vulnerabilities

Do not open a public issue containing an exploit, secret, user data, or provider payload. Contact
the maintainer privately with affected versions, reproduction steps, impact, and suggested
mitigation. Rotate exposed credentials immediately and preserve sanitized audit evidence.

## Web search and tool execution

Tool adapters fail closed: registering an adapter does not make it available. An administrator must
explicitly allowlist it, and every user invocation is persisted through the `ToolExecutionStore`
boundary in `pending_approval` until that same user approves it. Revocation is checked again at
approval time. Running adapters receive an `AbortSignal`; cancellation is a terminal compare-and-set
transition so late results cannot replace it.

The built-in SearXNG adapter rejects URL credentials, unexpected ports, redirects, non-HTTP schemes,
mixed public/private DNS answers, private/link-local/loopback/documentation addresses, wrong
response MIME types, oversized responses, and malformed JSON. Private-network access requires the
deployment setting and still requires the admin tool policy to allow private networking and the
exact endpoint domain. Returned result links are never fetched by the adapter.

The default Compose deployment pins SearXNG by multi-platform image digest, exposes it only on the
private backend network, mounts a read-only JSON-enabled configuration, drops all capabilities, and
runs with a read-only root filesystem. It is registered as an adapter, not automatically
allowlisted: an administrator must allow the `searxng` domain and private-network access before
users can request searches.

Production uses the PostgreSQL-backed `ToolExecutionStore` with atomic state transitions, optimistic
policy versions, durable reservations, startup recovery, and cancellation fencing.
`MemoryToolExecutionStore` remains limited to development and tests.
