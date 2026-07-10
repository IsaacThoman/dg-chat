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
registration. Generic OIDC remains a follow-up integration.

Markdown, Mermaid, citations, artifacts, filenames, provider errors, and tool results are rendered
as hostile content under a restrictive Content Security Policy. Raw HTML is disabled unless passed
through a maintained sanitizer. Spreadsheet formulas are escaped in CSV exports.

File upload routes are deliberately unavailable in the current release. Do not enable them until
streaming limits, MIME sniffing, quarantine scanning, immutable object keys, signed access, and
ownership checks are implemented and tested.

The current OpenAI-compatible provider transport resolves every A and AAAA answer, rejects
special-use destinations, and pins the approved address while preserving TLS hostname validation. It
rejects redirects and bounds response and streaming bytes. Future OCR, search, tool, upload, and
sandbox fetchers must independently enforce redirect, decompression, image-dimension, and duration
limits before those features are enabled.

## Secrets and privacy

API token plaintext is revealed once and never logged; only its SHA-256 hash and preview persist.
The current provider credential is supplied by environment variable and is never exposed through an
admin API. A future provider registry must add envelope encryption before accepting credentials.

Public chat snapshots are not implemented in the current release. Conversations remain private to
their owner. A future sharing implementation must be revocable, read-only, pinned to an immutable
leaf, independently control identity and attachment exposure, and invalidate cached access on
revocation.

## Reporting vulnerabilities

Do not open a public issue containing an exploit, secret, user data, or provider payload. Contact
the maintainer privately with affected versions, reproduction steps, impact, and suggested
mitigation. Rotate exposed credentials immediately and preserve sanitized audit evidence.
