# Development

## Requirements

- Deno 2.x (the root manifest declares the minimum supported release)
- Docker Engine with Docker Compose 2.24.4 or later (the development overlay uses `!override`)
- Git

Copy `.env.example` to `.env`, replace every placeholder secret, then start dependencies and the
three development processes:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up postgres redis minio minio-init
deno task db:migrate
deno task dev
deno task dev:web
deno task dev:worker
```

Alternatively, run the complete hot-reload stack in containers:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

`.env.example` uses `localhost` URLs for Deno processes run directly on the host. The development
Compose overlay deliberately replaces `DATABASE_URL`, `REDIS_URL`, and `S3_ENDPOINT` for the API,
migration job, and worker with the `postgres`, `redis`, and `minio` service DNS names. Host-oriented
values in `.env` therefore cannot accidentally send a container back through a published host port.

The web UI is at `http://localhost:5173`, the API at `http://localhost:8000`, MinIO at
`http://localhost:9000`, and its development console at `http://localhost:9001`. The development
overlay publishes these ports, PostgreSQL, and Redis on the loopback interface only; it does not
make them reachable from the local network. PostgreSQL, Redis, and MinIO are not published by the
production Compose file. Conversation-search admission is independently renewable and defaults to a
15-second crash-recovery lease, safely beyond its 5-second PostgreSQL statement deadline. Worker
replicas retry transient PostgreSQL outages with bounded, downward-only jitter. During database
restart testing, an already claimed job is neutrally deferred without consuming its application
retry budget; S3 and provider transport failures remain ordinary job failures.

## Bootstrap and accounts

Set `SETUP_TOKEN` before first start. Bootstrap exactly one administrator through
`POST /api/setup/bootstrap`, then rotate or remove the token. Public sign-ups remain pending until
an administrator approves them. Never use the first public registrant as an implicit administrator.

## Quality checks

```sh
deno task check
deno task test
deno task build
npx playwright install chromium
npx playwright test
```

Run the normalized PostgreSQL suite against a migrated disposable database by setting both
`DATABASE_URL` and `TEST_DATABASE_URL`, then running `deno task db:migrate` followed by
`deno test packages/database --allow-env --allow-net --allow-read --allow-write`.

CI creates one freshly migrated PostgreSQL template and clones it into a separate database for every
live database, API, and worker test file. The files run in sorted, explicit sequence, so a suite
that truncates global tables cannot erase or satisfy another suite's fixtures. The helper
`tests/run-postgres-test-group.ts` is CI-only destructive infrastructure. It refuses to operate
unless `DG_CHAT_ALLOW_DESTRUCTIVE_TEST_DATABASES` is exactly `true`, derives every database from a
reserved `dgchat_ci_*_` namespace, and records ownership outside each target database before it can
ever force-drop that name. Do not enable or invoke it against a shared or production PostgreSQL
cluster; use an ephemeral CI service whose loss is acceptable.

With a disposable DG Chat stack running, execute the supported OpenAI SDK contract surface with:

```sh
SETUP_TOKEN=your-disposable-setup-token bash tests/run-openai-contracts.sh
```

The runner uses pinned official JavaScript and Python OpenAI clients. Unsupported endpoints remain
listed as explicit TODOs in `tests/contracts/unsupported-contracts.json` until implemented.

Playwright defaults to `http://localhost:5173`. Override `E2E_BASE_URL`, `E2E_API_URL`,
`E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD`, and `SETUP_TOKEN` for another environment. Tests create
unique accounts and must only run against disposable installations.

The E2E harness fails closed when either URL is not loopback. A remote disposable installation
requires the exact opt-in `E2E_ALLOW_DESTRUCTIVE_REMOTE=true` plus explicitly supplied
`SETUP_TOKEN`, `E2E_ADMIN_EMAIL`, and `E2E_ADMIN_PASSWORD`; local fixture credential defaults are
never used for a remote target. The suite creates and mutates administrator, user, conversation,
token, file, and provider state, so never enable this guard for a production installation.

The ordinary development stack leaves OIDC disabled, so the OIDC journey is skipped in a local
non-strict run. To exercise the complete browser suite against the development UI, start the
disposable stack with the CI, provider, and OIDC test overlays and then run Playwright:

```sh
SETUP_TOKEN=e2e-setup-token WEB_URL=http://localhost:5173 docker compose \
  -f docker-compose.yml \
  -f docker-compose.dev.yml \
  -f docker-compose.ci.yml \
  -f docker-compose.contracts.yml \
  -f docker-compose.oidc.yml up -d --build
SETUP_TOKEN=e2e-setup-token E2E_FULL_STACK=true npx playwright test
```

CI uses the dedicated `docker-compose.ci.yml` overlay to raise authentication limits for its many
short-lived browser contexts. The ordinary development overlay retains production-safe limits.
Desktop and mobile projects run in separate matrix jobs with independent Compose projects, users,
databases, object stores, and volumes. CI uses the production web container at
`http://localhost:8000` and treats a missing OIDC provider as a configuration error rather than
silently skipping the journey.

A separate CI smoke starts the base Compose file without any test overlay, proves the compiled API
is running with `DENO_ENV=production`, checks every service and one-shot initializer, then stops the
API and worker within their Compose grace period. Exit code, OOM, and forced-kill assertions must
pass before both services are restarted and the complete health check is repeated.

The deterministic provider used by integration and UI tests runs with:

```sh
deno run --allow-net --allow-env=MOCK_PROVIDER_PORT tests/mock-provider.ts
```

It exposes OpenAI-compatible routes on port 4010. Model names select behavior: `mock-fast`,
`mock-slow`, `mock-reasoning`, `mock-tool`, `mock-fail`, and `mock-fail-first`.

## Database changes

Change the Drizzle schema, generate a versioned migration, inspect the SQL, and run migrations
against a disposable database before committing. Runtime schema synchronization and destructive
`push` commands are prohibited. Include upgrade and rollback/forward-fix notes with data migrations.
