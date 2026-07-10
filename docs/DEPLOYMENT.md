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
ENCRYPTION_KEY=... # keyring value documented by the application
SETUP_TOKEN=... # one-time bootstrap secret
APP_URL=https://chat.example.com
WEB_URL=https://chat.example.com
```

The bundled `minio-init` service creates the private bucket and provisions this application identity
with only list, location, read, write, and delete permissions for that bucket. Never set
`S3_ACCESS_KEY` to `MINIO_ROOT_USER`; managed S3 deployments should provide an equivalently scoped
identity. `MINIO_APP_POLICY_NAME` may be set to an installation-unique policy name when multiple
deployments share one MinIO control plane. Its default is derived from the application access key.

Uploads default to 25 MiB with at most four concurrent uploads per application replica and two per
user. Tune `UPLOAD_MAX_BYTES`, `UPLOAD_MAX_CONCURRENT`, and `UPLOAD_MAX_CONCURRENT_PER_USER` while
keeping the application `/tmp` tmpfs large enough for the resulting worst-case staged bytes.

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

The default images are version-tagged but operators should pin image digests after validation. Run
the app and worker at the same release during migrations. Apply expand/contract migrations in
separate releases so rolling upgrades remain compatible.

## Managed dependencies

PostgreSQL, Redis, and S3 can be externalized by overriding their connection environment variables
and removing the matching Compose dependencies. PostgreSQL must provide the `vector` extension.
Object storage needs private buckets, server-side encryption, lifecycle rules compatible with the
application retention policy, and CORS only if direct browser uploads are enabled.

## Backups and restore

Back up PostgreSQL and the object bucket as one recovery set. Redis does not require backup for
correctness. Keep encrypted backups outside the deployment host and test restoration regularly.

1. Quiesce writes or take a database snapshot with a matching object-store version marker.
2. Export PostgreSQL in a format supported by the target server version.
3. Replicate the private bucket, including object versions when enabled.
4. Record the application image digest, migration version, and encryption-key identifiers.
5. Restore into an isolated environment, run migrations and readiness checks, then verify login, a
   branched conversation, token authentication, and ledger totals. The application-level validated
   restore dry-run and attachment lifecycle are not implemented yet; use native PostgreSQL restore
   validation until those features ship.

Never discard an encryption key while provider credentials or privileged exports still depend on it.
Secret-bearing backup exports require separate encryption and must not be placed in the normal chat
export path.

## Upgrades and rollback

Before upgrading, read migration notes, take a recovery point, and verify at least twice the largest
table's free storage. Deploy the new app, run migrations once, then deploy workers. Roll back only
when the old binary is compatible with the migrated schema; otherwise forward-fix or restore the
recovery set.

## Monitoring

Alert on readiness, HTTP error ratio, stream starts without first tokens, queue age, failed jobs,
credit settlement backlog, database saturation, Redis availability, object-store errors, and disk
growth. Provider health is a degraded dependency and should not make `/health` fail.
