# Disposable multi-replica load testing

The load harness proves four distributed invariants against a fresh, production-shaped Compose
stack:

1. simultaneous long-lived SSE responses remain incremental and all reach one terminal event; the
   host restarts the exact API replica whose per-target in-flight gauge proves it owns an open
   streaming request;
2. edits append immutable sibling branches, while same-version concurrent-tab edits produce one
   winner and bounded `409` conflicts without losing the original branch;
3. concurrent API calls create one terminal usage run, one reserve entry, and one settle-or-refund
   entry each, while balances remain nonnegative and ledger sequences reconcile;
4. work queued while every worker is stopped completes exactly once after three worker replicas
   restart, including exactly one completion audit event; a test-only transaction pause covers both
   `queued → running` and empty-retention `queued → completed` paths, allowing the host to map a
   durable claim identity to its real worker container, kill that owner, and prove lease recovery.

This is a destructive test. It must never target an existing installation.

## Safety boundary

`tests/load/run.sh` refuses to start unless all of these conditions hold:

- `DG_CHAT_LOAD_ALLOW_DESTRUCTIVE` is exactly `true`;
- the generated Compose project begins with `dg-chat-load-`;
- the PostgreSQL database begins with `dgchat_load_`;
- application and PostgreSQL listeners use loopback only;
- the artifact directory is below `test-results/load`;
- every started container has both the expected Compose project label and the load-owned label;
- PostgreSQL reports the generated database as its current database.

PostgreSQL, the mock provider, and Prometheus join a disposable non-internal `load-host` bridge in
addition to the production-shaped internal backend. Docker requires that extra bridge for their
loopback-only host publications to work; it does not publish them on a LAN address or make the
production backend non-internal.

The host script, rather than a container, performs the controlled worker stop/start. No container
receives the Docker socket. Every run uses new named volumes, installs a cleanup trap before
starting services, captures Compose logs, and executes
`docker compose down --volumes
--remove-orphans` whether the run passes, fails, times out, or
receives a termination signal. Compose evidence is capped at the most recent 5,000 lines so a
pathological service cannot create an unbounded CI artifact. The active Docker context must itself
use a local Unix socket or Windows named pipe; SSH and TCP contexts are rejected even when their
published application ports would be loopback.

The harness never accepts a remote target. To load-test an existing or remote installation, build a
separate non-destructive benchmark with installation-specific approval instead of weakening these
guards.

## Profiles

| Profile     | Streams | Independent edits | Accounting calls | Overall runner bound |
| ----------- | ------: | ----------------: | ---------------: | -------------------: |
| `ci`        |       6 |                12 |               12 |           12 minutes |
| `standard`  |      12 |                30 |               30 |           20 minutes |
| `scheduled` |      24 |                60 |               60 |           30 minutes |

All profiles execute all four categories and the same invariant assertions. Larger profiles increase
concurrency only; there is no unbounded mode.

## Run locally

Docker, Docker Compose v2, Deno 2, OpenSSL, and `jq` are required. The default ports are `18080` for
the web proxy and `15432` for PostgreSQL.

```bash
DG_CHAT_LOAD_ALLOW_DESTRUCTIVE=true LOAD_PROFILE=standard deno task load
```

Use alternate unused loopback ports when necessary:

```bash
DG_CHAT_LOAD_ALLOW_DESTRUCTIVE=true \
LOAD_WEB_HOST_PORT=28080 \
LOAD_POSTGRES_HOST_PORT=25432 \
deno task load
```

The summary is written to `test-results/load/<run-id>/summary.json`. It is versioned, contains one
bounded result object per phase, and does not contain generated credentials. `progress.json`,
`runner.log`, `compose.log`, and the coordination markers make failed runs diagnosable.
`streams-active.json` is emitted only after the runner has observed at least two concurrently open
response bodies. The host independently confirms a positive per-replica Prometheus in-flight gauge,
maps that scrape target to its Docker container IP, and records the exact restarted container and
metric target in `api-chaos-complete.json`.

To exercise only the fail-closed preflight without touching Docker:

```bash
DG_CHAT_LOAD_ALLOW_DESTRUCTIVE=true \
LOAD_RUN_ID=preflight \
bash tests/load/run.sh --preflight-only
```

## Continuous integration

`.github/workflows/load.yml` runs the complete `ci` profile on every pull request. A weekly schedule
runs the `scheduled` profile, and manual dispatches can select any bounded profile. Artifacts are
uploaded even after failure. The job has a 45-minute outer timeout in addition to the runner and
per-request timeouts.

When the check fails, inspect `summary.json` first. A `streams-active.json` marker without
`api-chaos-complete.json` means no active Prometheus target could be mapped or restarted. A missing
queue phase combined with `queue-enqueued.json` means claimed-job recovery failed after the worker
restart; no marker means an earlier API or invariant phase failed. `compose.log` is the
authoritative service log for that disposable run.
