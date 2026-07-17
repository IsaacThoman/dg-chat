# Deployment

## Production Compose

Create a private `.env` file containing strong, unique values for at least:

```dotenv
POSTGRES_PASSWORD=...
MINIO_ROOT_USER=...
MINIO_ROOT_PASSWORD=...
S3_ACCESS_KEY=... # bucket-scoped application identity, different from the root user
S3_SECRET_KEY=...
APP_SECRET=... # at least 32 random bytes
ENCRYPTION_KEY=... # exactly 32 random bytes encoded as base64
BACKUP_SIGNING_KEY=... # independent, exactly 32 random bytes encoded as base64
BACKUP_SIGNING_KEY_ID=installation-v1 # stable identifier recorded in every archive
ENABLE_PRIVILEGED_SECRET_BACKUPS=false # privileged provider-secret recovery is a separate opt-in
SETUP_TOKEN=... # one-time bootstrap secret
APP_URL=https://chat.example.com
WEB_URL=https://chat.example.com
```

Generate independent provider-encryption and backup-signing keys with `openssl rand -base64 32`. Do
not reuse either key for the other purpose. For rolling provider-secret rotation, set
`ENCRYPTION_KEYRING` to a JSON object mapping stable key IDs to base64 keys and set
`ENCRYPTION_PRIMARY_KEY_ID` to the key used for new credentials. Keep old keys in the keyring until
each provider credential has been explicitly replaced through the admin console under the new
primary key; an online bulk rewrap command is not yet shipped. `ENCRYPTION_KEY` remains the
supported single-key form.

Privileged provider-secret recovery artifacts are disabled by default. To prepare their independent
key domain, set `BACKUP_SECRET_KEYRING` to a JSON object of stable key IDs and canonical base64
32-byte keys, set `BACKUP_SECRET_PRIMARY_KEY_ID` to the key used for new artifacts, and explicitly
set `ENABLE_PRIVILEGED_SECRET_BACKUPS=true`. Generate these keys independently: startup rejects any
recovery key that equals a configured provider-encryption or backup-signing key. Rotation changes
the primary ID while retaining prior keys until every recovery artifact encrypted with them has
expired. Never publish or include this keyring in an ordinary `.dgbackup` archive.

The bundled `minio-init` service creates the private bucket and provisions this application identity
with only list, location, read, write, and delete permissions for that bucket. Never set
`S3_ACCESS_KEY` to `MINIO_ROOT_USER`; managed S3 deployments should provide an equivalently scoped
identity. `MINIO_APP_POLICY_NAME` may be set to an installation-unique policy name when multiple
deployments share one MinIO control plane. Its default is derived from the application access key.

Both the API and background worker require the same `S3_*` application credentials. The bundled
Compose stack passes them to both services and holds startup until `minio-init` has provisioned the
bucket-scoped identity. Custom deployments must preserve that ordering because text/JSON ingestion
reads immutable objects directly from the worker.

Object-storage endpoints must use HTTPS by default. The bundled private MinIO network deliberately
uses HTTP and therefore sets `S3_ALLOW_INSECURE=true`; that opt-in is accepted only for loopback,
private IP addresses, and single-label container service names such as `minio`. Never enable it for
a public or externally routed endpoint. Terminate TLS at the object store for those deployments.

Uploads default to 25 MiB with at most four concurrent uploads per application replica and two per
user. Tune `UPLOAD_MAX_BYTES`, `UPLOAD_MAX_CONCURRENT`, and `UPLOAD_MAX_CONCURRENT_PER_USER` while
keeping the application `/tmp` tmpfs large enough for the resulting worst-case staged bytes.
Interrupted content-addressed uploads remain resumable for seven days by default. After
`FILE_UPLOAD_RECOVERY_MAX_AGE_SECONDS`, the API refunds the reservation, records an explicit
`upload_recovery_expired` terminal response, and schedules delayed reference-fenced object cleanup.
This age policy bounds permanently ambiguous storage failures without labeling them as corruption.

Audio transcription is independently bounded to 25 MiB per request and defaults to four active
requests across all API replicas, with two per user. Tune `AUDIO_MAX_CONCURRENT` and
`AUDIO_MAX_CONCURRENT_PER_USER` together; the per-user value must not exceed the global value.
Redis-backed admission uses renewable, crash-safe leases. `AUDIO_CONCURRENCY_LEASE_SECONDS` defaults
to 120 seconds; keep it comfortably longer than transient Redis outages. Each active request keeps a
validated audio body and a bounded retry body in memory.

For an external object store, set an HTTPS `S3_ENDPOINT`, `S3_REGION`, and `S3_FORCE_PATH_STYLE` as
required by that service in addition to the bucket and scoped credentials.

Validate and launch:

```sh
docker compose config --quiet
docker compose build --pull
docker compose up -d
docker compose ps
curl --fail https://chat.example.com/ready
```

Wait for both `app` and `worker` to report healthy. Each worker boot generates a new UUID and writes
it atomically to its private `WORKER_INSTANCE_FILE` (default `/tmp/dg-chat-worker-instance`). The
health command accepts only that exact boot's `worker_instances` row: the state must be `running`,
both the independently refreshed heartbeat and loop/job progress timestamps must be fresh, and a
bounded S3 `HeadBucket` probe must succeed. A live process with a wedged job therefore differs from
an idle worker that is still advancing its poll loop, and an old healthy row cannot make a restarted
container healthy. A worker restart during initial deployment indicates a migration-ordering,
database-connectivity, object-storage, or liveness fault and should block rollout.

`WORKER_HEARTBEAT_INTERVAL_MS` defaults to 5 seconds and `WORKER_HEARTBEAT_STALE_MS` to 20 seconds;
the stale threshold must be at least two intervals. `WORKER_PROGRESS_STALE_MS` defaults to 180
seconds and should exceed the longest legitimate bounded job interval while remaining short enough
to detect a stalled handler. `WORKER_HEALTH_TIMEOUT_MS` defaults to 4 seconds and bounds the
database and S3 probes. Freshness uses the PostgreSQL clock rather than host time;
`WORKER_HEALTH_CLOCK_TOLERANCE_MS` allows at most 5 seconds of future-clock correction while still
failing closed on implausible timestamps. Stopped or very stale instance history is retained for
`WORKER_INSTANCE_RETENTION_HOURS` (168 by default), with cleanup performed safely by each boot
without sharing or replacing another replica's identity. SIGTERM immediately publishes a `draining`
state when PostgreSQL is available and the final fenced shutdown records `stopped` before closing
the pool. Containers have private `/tmp` namespaces. A bare-metal supervisor that launches multiple
workers in one filesystem namespace must assign each service a distinct `WORKER_INSTANCE_FILE`;
otherwise one process could overwrite another process's health identity.

`WORKER_JOB_LEASE_SECONDS` defaults to 120 seconds. Keep it longer than the maximum synchronous job
handler duration; expired claims are fenced and may be reclaimed by another worker. Transient
database outages are retried with bounded exponential backoff. Configure the initial and maximum
delays with `WORKER_DATABASE_RETRY_INITIAL_MS` and `WORKER_DATABASE_RETRY_MAX_MS`.
`WORKER_DATABASE_RETRY_JITTER_RATIO` (default `0.2`) randomly subtracts up to that fraction from
each delay, desynchronizing replicas without ever exceeding the configured exponential schedule.
`WORKER_DATABASE_OPERATION_TIMEOUT_MS` (default 5 seconds) bounds every worker-owned statement and
lock wait. Its SQLSTATE `57014` is neutrally deferred rather than consuming a job attempt or killing
the worker. `WORKER_SHUTDOWN_SETTLEMENT_TIMEOUT_MS` (default 10 seconds) is one absolute window for
fenced settlement, retries, graceful pool close, and forced pool destruction. A new settlement query
starts only when a complete statement-timeout window remains. Keep this value comfortably below the
worker's Compose `stop_grace_period` (30 seconds by default); the final watchdog exits at the
settlement deadline even if a database driver blackholes. Shutdown interrupts retry, network I/O,
extraction, and idle waits immediately. Safe interrupted work is neutrally returned to the queue
without consuming an application attempt. A deadline before embedding `fetch` is invoked is recorded
retry-safe and settled at zero cost. An embedding request aborted after provider dispatch is instead
made terminal and operator-visible: it is never replayed, and its reservation is conservatively
settled exactly once.

The watchdog remains armed until every graceful close resolves, or every forced close resolves after
a graceful rejection or timeout. A rejected close is never treated as success, and a blackholed
forced close cannot extend the absolute settlement budget. Job claims expose a remaining lease
duration rather than a database timestamp. The worker subtracts the complete observed claim round
trip and anchors the result to its monotonic clock, avoiding database/host wall-clock skew. Claim
renewal extends only the database reclaim fence; it never extends the original provider,
object-storage, or extraction deadline.

Startup reconciliation scans generated-object cleanup and missing embedding work in independently
committed batches. Large backlogs therefore make durable forward progress across statement timeouts
or restarts instead of replaying one unbounded startup transaction. The worker uses two small
two-connection pools and does not create the API-only conversation-search pool.

Document ingestion and knowledge retrieval must share one versioned embedding configuration. Set
`KNOWLEDGE_EMBEDDING_BASE_URL`, `KNOWLEDGE_EMBEDDING_API_KEY`, `KNOWLEDGE_EMBEDDING_MODEL`, and,
when needed, `KNOWLEDGE_EMBEDDING_UPSTREAM_MODEL` and `KNOWLEDGE_EMBEDDING_VERSION`. Compose passes
the same identity and pricing values to the API and worker; the API embeds retrieval queries while
the worker embeds document chunks. An incomplete configuration fails startup instead of silently
producing incompatible vectors. The base URL must be credential-free HTTPS in production.
`KNOWLEDGE_EMBEDDING_INPUT_MICROS_PER_MILLION` and `KNOWLEDGE_EMBEDDING_FIXED_CALL_MICROS` are
USD-micro prices used for both paths; explicit zeroes support self-hosted models without inventing
provider cost.

The worker retries only explicitly transient PostgreSQL SQLSTATEs. Connection rejection (`08004`),
protocol violations (`08P01`), authentication failures, schema errors, and invalid configuration
remain fatal. After a claim, a transient fault from an explicitly marked database operation is
settled as a neutral, fenced defer that reverses the claim's attempt increment. The settlement is
retried under that claim; if another replica reclaims it first, its claim token prevents the stale
worker from mutating the job. Identical transport codes from S3 or a model provider are ordinary
application failures and consume the job's configured retry budget.

The app is published on `${PORT:-8000}`. Put it behind a TLS-terminating reverse proxy and forward
the original scheme and host. Preserve streaming responses by disabling proxy buffering for `/v1/*`
and chat streams and by setting idle timeouts above the maximum generation timeout.

The generic Compose file intentionally contains no installation-specific reverse-proxy network
label. If an orchestrator attaches `web` to several routable networks, configure that platform's
network-selection label in a deployment-local override instead of committing a generated network ID
to the application manifest. Compose health checks cover the API, worker, public web proxy, and
isolated search proxy; route traffic only after all required services are healthy.

The bundled public nginx serves the web app with `X-Content-Type-Options: nosniff` and a restrictive
Content Security Policy. Executable scripts, API connections, fonts, the manifest, and the PWA
worker are same-origin only; inline script and dynamic evaluation are not allowed. The one
render-blocking theme initializer is a release static asset, so the saved theme is applied before
React paints without weakening `script-src`. Inline styles remain allowed because React positions
menus at runtime and sanitized Mermaid SVGs carry presentation styles. Blob image/audio URLs support
local previews and playback, while user-approved Markdown images may load over HTTPS. OIDC starts at
the same-origin API and then uses a top-level provider navigation, so it does not require adding an
identity provider to `connect-src`. If a replacement proxy sets its own CSP, preserve these
capabilities without adding `unsafe-inline` or `unsafe-eval` to `script-src`.

`/metrics` is deliberately unavailable on the public nginx listener and returns a fixed JSON 404.
The API and worker exporters instead listen on ports 9090 and 9091 respectively inside the private
backend network. The application containers do not publish either port. Do not replace this deny
rule with a proxy to the application or expose an operational endpoint through the product origin.

Every application migration that creates a portable or explicitly cleared business table must also
attach the `dg_chat_restore_maintenance_fence` statement trigger. Backup catalog validation fails
closed when either the table's portability policy or its fence is missing. Do not attach that
trigger to `backup_operations`, `installation_state`, or `repository_migrations`; restore recovery
must be able to update those control tables while the fence is active.

The default images are version-tagged but operators should pin image digests after validation. Run
the app and worker at the same release during migrations. Apply expand/contract migrations in
separate releases so rolling upgrades remain compatible.

## Managed dependencies

For externally managed PostgreSQL, Redis, and S3-compatible storage, set `DATABASE_URL`,
`REDIS_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, and `S3_SECRET_KEY`, then use the
supported overlay:

```sh
docker compose -f docker-compose.yml -f docker-compose.managed.yml up -d --build
```

The overlay passes the exact database URL to the API, migration job, and worker; attaches the
migration job to the egress network; removes local PostgreSQL, Redis, and MinIO dependency gates;
and excludes those bundled services from ordinary startup through the `bundled-dependencies`
profile. It renders without `POSTGRES_PASSWORD`, `MINIO_ROOT_USER`, or `MINIO_ROOT_PASSWORD` because
those credentials belong only to disabled bundled services. Do not enable the profile in a managed
deployment unless deliberately bringing the local services back and supplying their credentials.

Without this overlay, omitted connection variables select the bundled `postgres`, `redis`, and
`minio` DNS names. Bundled startup still requires non-empty `POSTGRES_PASSWORD`, `MINIO_ROOT_USER`,
and `MINIO_ROOT_PASSWORD`; missing values resolve only to deliberately invalid local-service
credentials, causing the official images to fail closed rather than install known defaults.
PostgreSQL must provide the `vector` extension. Object storage needs private buckets, server-side
encryption, lifecycle rules compatible with the application retention policy, and CORS only if
direct browser uploads are enabled.

## Backups and restore

The Storage section of the admin console creates a versioned `.dgbackup` recovery artifact
containing a repeatable-read relational snapshot and every referenced immutable object. The manifest
and every entry are integrity checked and authenticated with `BACKUP_SIGNING_KEY`; normal exports
redact provider credentials and exclude diagnostic request/response bodies by default. They still
contain password hashes, API-token hashes, chat content, attachments, and accounting data, so
encrypt them at rest, restrict access, and copy them off the application object store. Losing a
signing key makes its archives unverifiable. Retain old signing keys and their IDs for as long as
their archives exist; the current v1 runtime accepts the configured key ID only, so restore an old
archive with the matching key in an isolated deployment.

Exports spool data under `/tmp`. `BACKUP_MAX_UPLOAD_BYTES` defaults to 1 GiB and is a hard restore
upload bound (maximum 16 GiB). Compose gives `/tmp` a 2 GiB tmpfs by default; set
`BACKUP_TEMP_STORAGE_SIZE` above the largest expected archive plus working overhead, while
accounting for concurrent ordinary uploads and available RAM. Large installations should continue
using native, streaming database and object-store backups because the application export is
currently a single replica-local job.

Restore is deliberately disabled until `ALLOW_IN_APP_RESTORE=true`. Before enabling it:

1. Take and verify a native PostgreSQL and object-store recovery point.
2. Put the installation in an operator maintenance window and stop all but one API replica and all
   workers. The application also establishes a durable write fence while applying the archive.
3. Upload the `.dgbackup`, run the dry-run, resolve every blocker, and compare its full SHA-256
   fingerprint to the expected out-of-band value.
4. Type the requested fingerprint confirmation and apply. Restore replaces portable installation
   tables transactionally, stages objects before database references, clears ephemeral jobs and
   replay state, and invalidates every browser session. Provider credentials remain disabled because
   normal exports contain redacted placeholders; re-enter them after signing in again.
5. Keep the API process running until completion. If it exits after the database commit, restart the
   same release with the same database, object store, and signing key; startup recovery finalizes
   the durable operation and releases maintenance without replaying the replacement.
6. Sign in, verify users, balances, a branched conversation and its attachments, create a fresh API
   token, reconnect providers, then restart workers and additional API replicas.

Dry-run uses the same strict parser and relational validation as apply but writes only temporary
staging tables. A successful dry-run is not permission to restore an archive from an untrusted
source: signatures prove possession of the installation key, not that its contents are desirable.

Native disaster-recovery backups remain recommended in addition to portable exports. Back up
PostgreSQL and the object bucket as one recovery set. Redis does not require backup for correctness.
Keep encrypted backups outside the deployment host and test restoration regularly.

1. Quiesce writes or take a database snapshot with a matching object-store version marker.
2. Export PostgreSQL in a format supported by the target server version.
3. Replicate the private bucket, including object versions when enabled.
4. Record the application image digest, migration version, and encryption-key identifiers.
5. Restore into an isolated environment, run migrations and readiness checks, then verify login, a
   branched conversation, token authentication, attachments, and ledger totals.

Never discard an encryption key while provider credentials or privileged exports still depend on it.
Normal portable exports always redact provider credentials. When privileged secret backups are
explicitly enabled, an administrator can create a separate recovery-key-encrypted `.dgsecrets`
sidecar bound to the exact `.dgbackup` digest and content root. Store and transfer the two files as
a pair, retain every referenced recovery key, and require recent authentication for export,
download, upload, dry-run, and apply. On restore, apply the normal archive first, sign in again as
an administrator from the restored installation, then dry-run and apply its matching sidecar.
Secrets are re-encrypted under the destination provider keyring and every restored provider remains
disabled until it is tested and deliberately enabled.

## Upgrades and rollback

Before upgrading, read migration notes, take a recovery point, and verify at least twice the largest
table's free storage. Deploy the new app, run migrations once, then deploy workers. Roll back only
when the old binary is compatible with the migrated schema; otherwise forward-fix or restore the
recovery set.

Migration `0008` adds the usage pricing-snapshot check as `NOT VALID`, so existing accounting rows
are not scanned under the deployment transaction while every new row is still enforced. Validate it
later during a maintenance window with
`ALTER TABLE usage_runs VALIDATE CONSTRAINT usage_runs_pricing_snapshot_check`; installations that
need reverse price-to-usage lookups may then add a partial pricing-version index concurrently.

Migration `0025` adds operational analytics and job-pagination indexes using transactional
`CREATE INDEX`. On installations with large `usage_runs` or `jobs` tables, schedule this migration
inside a maintenance window because PostgreSQL can briefly block writes while each index is built.
Take a recovery point first, monitor lock waits and free disk, and do not start the new application
or workers until migration completion. A future online-migration runner may replace this explicit
maintenance-window requirement with `CREATE INDEX CONCURRENTLY`.

Migration `0040` enables `pg_trgm` and transactionally builds GIN indexes over conversation titles
and visible user/assistant message content. The current Drizzle runner wraps each migration in a
transaction, so PostgreSQL does not permit `CREATE INDEX CONCURRENTLY`. For an existing
installation, stop every API and worker replica, confirm no application transaction is active, take
a recovery point, and run the migration once inside a maintenance window. The migration uses a
five-second `lock_timeout`: a competing writer makes the deployment fail and roll back cleanly
instead of waiting indefinitely. Leave the replicas stopped, drain the conflicting transaction, and
rerun the migration; do not bypass the timeout or manually mark `0040` complete. The index build
itself can be long-running and requires free disk proportional to the indexed title and message
content.

Migration `0026` adds the disabled-by-default diagnostic capture and retention subsystem. It adds a
composite uniqueness constraint to `provider_attempts` and creates new policy, capture, and
scrub-run tables; it does not rewrite existing provider-attempt rows. After deployment, confirm the
Retention admin screen reports capture disabled, run a zero-result preview, and verify the worker
can query the new durable job type before enabling capture.

Migration `0049` makes retention scrub runs system-ownable and adds the singleton automatic
retention schedule. Every worker may check the schedule: PostgreSQL serializes those checks on the
singleton row and commits the snapshotted scrub run, durable job, schedule advance, and null-actor
audit evidence in one transaction. The default interval is one day
(`RETENTION_SCRUB_INTERVAL_SECONDS=86400`, bounded from 300 through 2592000 seconds), checked once a
minute (`RETENTION_SCHEDULER_POLL_SECONDS=60`, bounded from 10 through 3600 seconds). Missed cadence
slots coalesce into one run with current cutoffs, policy changes trigger a fresh run without waiting
for the old deadline, and a shorter configured interval is rebased from the last durable schedule.
Backups include the schedule state; restoring an older supported archive initializes it due
immediately.

## Monitoring

Alert on readiness, HTTP error ratio, stream starts without first tokens, queue age, failed jobs,
credit settlement backlog, database saturation, Redis availability, object-store errors, and disk
growth. Provider health is a degraded dependency and should not make `/health` fail.

`/health` is process liveness. `/ready` applies a hard two-second deadline to each PostgreSQL,
Redis, and object-storage probe by default; tune all probes with `READINESS_TIMEOUT_MS` or an
individual `POSTGRES_READINESS_TIMEOUT_MS`, `REDIS_READINESS_TIMEOUT_MS`, or
`S3_READINESS_TIMEOUT_MS` value between 1 and 30000 milliseconds. The API returns a sanitized 503
when any configured required dependency misses its deadline. The bundled API container has a
35-second healthcheck timeout and coalesces concurrent readiness checks behind a result cached for
500 monotonic milliseconds, preventing probe amplification while still reacting quickly to
dependency state changes. Readiness responses use `Cache-Control: no-store` so intermediaries cannot
extend that TTL. It has a 30-second stop grace period, allowing its HTTP and resource-drain budgets
to complete.

Production startup fails closed unless `DATABASE_URL`, `REDIS_URL`, and S3-compatible object storage
are configured. Development and test processes may intentionally use in-memory database and
coordination adapters. Each `/ready` dependency entry reports `configured`, `ready`, and a sanitized
`implementation` (`postgres`, `redis`, `s3`, `memory`, `custom`, or `none`), so an in-process
fallback can never be mistaken for live Redis or durable object storage. Production also binds
readiness to the exact `postgres`, `redis`, and `s3` implementations. A miswired in-process adapter
therefore remains `not_ready` even when that adapter is healthy.

Each HTTP response includes a server-generated `X-Request-Id`, exposed to allowed browser origins.
Caller-supplied values are not reused as authoritative correlation IDs. Request logs are one JSON
object per request and contain only that UUID, method, registered route template, status, and
duration. They deliberately exclude raw paths, query strings, request headers, user identifiers, and
exception messages. The bundled nginx access log coarsens API, OpenAI, chat, admin, and public-share
paths so concrete identifiers and bearer capabilities are not emitted. Keep the same query/path
redaction policy in any replacement reverse proxy.

Start the bundled private scraper and executable alert rules with:

```sh
docker compose --profile observability up -d prometheus
```

The Prometheus UI is published through `PROMETHEUS_HOST_PORT` on `PROMETHEUS_BIND_ADDRESS=127.0.0.1`
by default; firewall it before choosing a non-loopback bind on a remote host. Prometheus has no
startup dependency on the API or worker, so it can boot with zero targets and report their absence.
API and worker exporters use fixed private ports 9090 and 9091 respectively; these ports are
deliberately not configurable because the bundled discovery contract must never drift. Run
`bash tests/assert-observability-profile.sh` against a disposable healthy stack to exercise scaled
DNS discovery, the private exporter boundary, loaded alert rules, and zero-target detection. For a
rolling upgrade, an inherited `METRICS_PORT` equal to that service's fixed port is accepted as a
deprecated no-op; remove it after the rollout. Any conflicting value fails startup.
`deploy/prometheus/alerts.yml` covers target/readiness failures, dependency failures, API 5xx ratio,
post-dispatch HTTP response-body failures, queue depth/age/stalls, worker database failures,
provider failures, and observed open circuits. Queue gauges come from a bounded 15-second worker
query; provider counters are emitted at the durable terminal-attempt boundary. HTTP lifecycle
counters distinguish completed, cancelled, and failed delivery without exposing request content.
They contain neither user nor model/provider labels.

Native Deno OpenTelemetry must remain disabled with `OTEL_DENO=false`: native server and client
spans retain raw full URLs, paths, and queries in their exported attribute list, even after user
code adds redacted replacements. Enable DG Chat's privacy-bounded manual SDK with
`DG_CHAT_OTEL_ENABLED=true`, an explicit credential-free `OTEL_EXPORTER_OTLP_ENDPOINT` (or the
trace-specific endpoint), and optionally an `OTEL_EXPORTER_OTLP_HEADERS` deployment secret. The
exporter owns that header value and DG Chat never logs or returns it. The supported protocol is
`http/protobuf`. `DG_CHAT_OTEL_SAMPLER=local_random_ratio` is the required privacy-bounded
algorithm, and its default 10% ratio is configurable with `OTEL_TRACES_SAMPLER_ARG`. Each remote or
root request receives a fresh, locally random sampling decision. Incoming W3C `traceparent`
identifiers are honored for correlation, but neither the remote sampled bit nor a caller-selected or
reused trace ID can override the local ratio. Caller-controlled `tracestate` and baggage are
ignored. API spans contain only bounded method and route-group attributes, while worker spans
contain only bounded job types and categorical outcomes. No raw URL, query, header,
user/model/provider identity, exception, prompt, or object key is attached. Shutdown closes both
private metrics listeners and gives the bounded batch exporter 2.5 seconds to flush.

During an upgrade, `OTEL_TRACES_SAMPLER` is ignored while DG Chat tracing is disabled. When tracing
is enabled, the exact legacy value `parentbased_traceidratio` is accepted as a deprecated migration
alias but is executed with DG Chat's safer local-random semantics; remove it and set
`DG_CHAT_OTEL_SAMPLER=local_random_ratio`. Any other legacy sampler value fails startup rather than
silently changing the privacy or telemetry-volume boundary.

Provider connection tests and discovery are limited by `PROVIDER_ADMIN_RATE_LIMIT` (30 mutations per
minute by default). Registry models are not published to users until the provider is enabled, has an
encrypted credential, the model is enabled, and an effective price revision exists.

Public conversation capabilities are protected independently per capability and per client by
`PUBLIC_SHARE_RATE_LIMIT` (120) and `PUBLIC_SHARE_CLIENT_RATE_LIMIT` (240) in the common
`RATE_LIMIT_WINDOW_SECONDS` window. Owner create/revoke operations use `SHARE_MUTATION_RATE_LIMIT`
(20). Public access fails closed when Redis is unavailable. If the API is behind a reverse proxy,
enable `TRUST_PROXY_HEADERS` only after that proxy strips inbound forwarding headers and supplies
the direct client address; without that trust boundary, the client ceiling intentionally becomes
installation-wide. Public capability paths must be redacted from proxy/access logs, and the web
`/share/*` route must retain `Referrer-Policy: no-referrer`.

Authenticated conversation search is limited independently per user by
`CONVERSATION_SEARCH_RATE_LIMIT` (30) in the common `RATE_LIMIT_WINDOW_SECONDS` window. A separate
distributed admission gate allows at most `CONVERSATION_SEARCH_MAX_CONCURRENT` (4) searches across
the installation and `CONVERSATION_SEARCH_MAX_CONCURRENT_PER_USER` (1) for one account. This keeps
slow full-text searches from exhausting every database connection. The API fails search closed with
a retryable service error when either shared limiter is unavailable. Search capacity uses a
dedicated Redis client and `CONVERSATION_SEARCH_CONCURRENCY_LEASE_SECONDS` defaults to 15 seconds.
It must be an integer greater than the PostgreSQL search statement deadline of 5 seconds and no
greater than 60 seconds. A crashed replica therefore cannot strand a slot beyond that bounded lease,
while a healthy query is cancelled before its admission fence can expire.
