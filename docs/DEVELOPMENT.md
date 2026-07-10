# Development

## Requirements

- Deno 2.x (the root manifest declares the minimum supported release)
- Docker Engine with Compose v2
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

The web UI is at `http://localhost:5173`, the API at `http://localhost:8000`, MinIO at
`http://localhost:9000`, and its development console at `http://localhost:9001`. PostgreSQL, Redis,
and MinIO are intentionally not published by the production Compose file.

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

Playwright defaults to `http://localhost:5173`. Override `E2E_BASE_URL`, `E2E_API_URL`,
`E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD`, and `SETUP_TOKEN` for another environment. Tests create
unique accounts and must only run against disposable installations.

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
