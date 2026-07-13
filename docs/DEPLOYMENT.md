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

Uploads default to 25 MiB with at most four concurrent uploads per application replica and two per
user. Tune `UPLOAD_MAX_BYTES`, `UPLOAD_MAX_CONCURRENT`, and `UPLOAD_MAX_CONCURRENT_PER_USER` while
keeping the application `/tmp` tmpfs large enough for the resulting worst-case staged bytes.

Audio transcription is independently bounded to 25 MiB per request and defaults to four active
requests across all API replicas, with two per user. Tune `AUDIO_MAX_CONCURRENT` and
`AUDIO_MAX_CONCURRENT_PER_USER` together; the per-user value must not exceed the global value.
Redis-backed admission uses renewable, crash-safe leases. `AUDIO_CONCURRENCY_LEASE_SECONDS` defaults
to 120 seconds; keep it comfortably longer than transient Redis outages. Each active request keeps a
validated audio body and a bounded retry body in memory.

For an external object store, set `S3_ENDPOINT`, `S3_REGION`, and `S3_FORCE_PATH_STYLE` as required
by that service in addition to the bucket and scoped credentials.

Validate and launch:

```sh
docker compose config --quiet
docker compose build --pull
docker compose up -d
docker compose ps
curl --fail https://chat.example.com/ready
```

Wait for both `app` and `worker` to report healthy. The worker health check verifies that its
process is running and that the migrated durable-job table is queryable. A worker restart during
initial deployment indicates a migration-ordering or database-connectivity fault and should block
rollout. `WORKER_JOB_LEASE_SECONDS` defaults to 120 seconds. Keep it longer than the maximum
synchronous job handler duration; expired claims are fenced and may be reclaimed by another worker.

The app is published on `${PORT:-8000}`. Put it behind a TLS-terminating reverse proxy and forward
the original scheme and host. Preserve streaming responses by disabling proxy buffering for `/v1/*`
and chat streams and by setting idle timeouts above the maximum generation timeout.

Every application migration that creates a portable or explicitly cleared business table must also
attach the `dg_chat_restore_maintenance_fence` statement trigger. Backup catalog validation fails
closed when either the table's portability policy or its fence is missing. Do not attach that
trigger to `backup_operations`, `installation_state`, or `repository_migrations`; restore recovery
must be able to update those control tables while the fence is active.

The default images are version-tagged but operators should pin image digests after validation. Run
the app and worker at the same release during migrations. Apply expand/contract migrations in
separate releases so rolling upgrades remain compatible.

## Managed dependencies

PostgreSQL, Redis, and S3 can be externalized by overriding their connection environment variables
and removing the matching Compose dependencies. PostgreSQL must provide the `vector` extension.
Object storage needs private buckets, server-side encryption, lifecycle rules compatible with the
application retention policy, and CORS only if direct browser uploads are enabled.

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

Migration `0026` adds the disabled-by-default diagnostic capture and retention subsystem. It adds a
composite uniqueness constraint to `provider_attempts` and creates new policy, capture, and
scrub-run tables; it does not rewrite existing provider-attempt rows. After deployment, confirm the
Retention admin screen reports capture disabled, run a zero-result preview, and verify the worker
can query the new durable job type before enabling capture.

## Monitoring

Alert on readiness, HTTP error ratio, stream starts without first tokens, queue age, failed jobs,
credit settlement backlog, database saturation, Redis availability, object-store errors, and disk
growth. Provider health is a degraded dependency and should not make `/health` fail.

Provider connection tests and discovery are limited by `PROVIDER_ADMIN_RATE_LIMIT` (30 mutations per
minute by default). Registry models are not published to users until the provider is enabled, has an
encrypted credential, the model is enabled, and an effective price revision exists.

Public conversation capabilities are protected independently per capability and per client by
`PUBLIC_SHARE_RATE_LIMIT` (120) and `PUBLIC_SHARE_CLIENT_RATE_LIMIT` (240) in the common
`RATE_LIMIT_WINDOW_SECONDS` window. Owner create/revoke operations use
`SHARE_MUTATION_RATE_LIMIT` (20). Public access fails closed when Redis is unavailable. If the API
is behind a reverse proxy, enable `TRUST_PROXY_HEADERS` only after that proxy strips inbound
forwarding headers and supplies the direct client address; without that trust boundary, the client
ceiling intentionally becomes installation-wide. Public capability paths must be redacted from
proxy/access logs, and the web `/share/*` route must retain `Referrer-Policy: no-referrer`.
