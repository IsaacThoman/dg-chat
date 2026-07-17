#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$ROOT"

die() {
  echo "Refusing load test: $*" >&2
  exit 2
}

[[ "${DG_CHAT_LOAD_ALLOW_DESTRUCTIVE:-}" == "true" ]] ||
  die "set DG_CHAT_LOAD_ALLOW_DESTRUCTIVE=true for this disposable stack."

profile="${LOAD_PROFILE:-ci}"
case "$profile" in
  ci | standard | scheduled) ;;
  *) die "LOAD_PROFILE must be ci, standard, or scheduled." ;;
esac

if [[ -n "${LOAD_RUN_ID:-}" ]]; then
  run_id="$LOAD_RUN_ID"
else
  run_id="$(date -u +%Y%m%d%H%M%S)-$$"
fi
[[ "$run_id" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] ||
  die "LOAD_RUN_ID must contain 1-31 lowercase letters, numbers, or hyphens."

export COMPOSE_PROJECT_NAME="dg-chat-load-${run_id}"
database_suffix="${run_id//-/_}"
export POSTGRES_DB="dgchat_load_${database_suffix}"
export POSTGRES_USER="dgchat"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(openssl rand -hex 18)}"
export LOAD_WEB_HOST_PORT="${LOAD_WEB_HOST_PORT:-18080}"
export LOAD_POSTGRES_HOST_PORT="${LOAD_POSTGRES_HOST_PORT:-15432}"
export LOAD_PROMETHEUS_HOST_PORT="${LOAD_PROMETHEUS_HOST_PORT:-19090}"
export LOAD_MOCK_HOST_PORT="${LOAD_MOCK_HOST_PORT:-14010}"
for port_name in \
  LOAD_WEB_HOST_PORT LOAD_POSTGRES_HOST_PORT LOAD_PROMETHEUS_HOST_PORT LOAD_MOCK_HOST_PORT; do
  port="${!port_name}"
  [[ "$port" =~ ^[0-9]+$ ]] && ((port >= 1024 && port <= 65535)) ||
    die "$port_name must be an unprivileged TCP port."
done
unique_ports="$(printf '%s\n' "$LOAD_WEB_HOST_PORT" "$LOAD_POSTGRES_HOST_PORT" \
  "$LOAD_PROMETHEUS_HOST_PORT" "$LOAD_MOCK_HOST_PORT" | sort -u | wc -l | tr -d ' ')"
[[ "$unique_ports" == 4 ]] || die "all published load-harness ports must differ."

export WEB_HOST_PORT="$LOAD_WEB_HOST_PORT"
export LOAD_BASE_URL="http://127.0.0.1:${LOAD_WEB_HOST_PORT}"
export LOAD_PROMETHEUS_URL="http://127.0.0.1:${LOAD_PROMETHEUS_HOST_PORT}"
export LOAD_MOCK_CONTROL_URL="http://127.0.0.1:${LOAD_MOCK_HOST_PORT}"
export LOAD_DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${LOAD_POSTGRES_HOST_PORT}/${POSTGRES_DB}"
export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}"
export LOAD_REPOSITORY_ROOT="$ROOT"
artifact_root="$ROOT/test-results/load"
mkdir -p "$artifact_root"
export LOAD_ARTIFACT_DIR="${LOAD_ARTIFACT_DIR:-$artifact_root/$run_id}"
mkdir -p "$LOAD_ARTIFACT_DIR"
LOAD_ARTIFACT_DIR="$(cd "$LOAD_ARTIFACT_DIR" && pwd -P)"
export LOAD_ARTIFACT_DIR
case "$LOAD_ARTIFACT_DIR/" in
  "$artifact_root/"*) ;;
  *) die "LOAD_ARTIFACT_DIR must be below $artifact_root." ;;
esac

command -v openssl >/dev/null || die "OpenSSL is required."
command -v deno >/dev/null || die "Deno is required."
# These values exist only for the disposable installation and are never written to artifacts.
export SETUP_TOKEN="${SETUP_TOKEN:-$(openssl rand -hex 24)}"
export APP_SECRET="${APP_SECRET:-$(openssl rand -hex 32)}"
export ENCRYPTION_KEY="${ENCRYPTION_KEY:-$(openssl rand -base64 32 | tr -d '\n')}"
export BACKUP_SIGNING_KEY="${BACKUP_SIGNING_KEY:-$(openssl rand -base64 32 | tr -d '\n')}"
export MINIO_ROOT_USER="${MINIO_ROOT_USER:-loadroot}"
export MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-$(openssl rand -hex 24)}"
export S3_ACCESS_KEY="${S3_ACCESS_KEY:-loadapp}"
export S3_SECRET_KEY="${S3_SECRET_KEY:-$(openssl rand -hex 24)}"
export SEARXNG_SECRET="${SEARXNG_SECRET:-$(openssl rand -hex 32)}"
export MOCK_PROVIDER_CONTROL_TOKEN="${MOCK_PROVIDER_CONTROL_TOKEN:-ci-mock-control-token}"
export PROMETHEUS_HOST_PORT="$LOAD_PROMETHEUS_HOST_PORT"

deno run --allow-env --allow-read tests/load/preflight.ts
if [[ "${1:-}" == "--preflight-only" ]]; then
  exit 0
fi
[[ $# -eq 0 ]] || die "the only supported argument is --preflight-only."

command -v docker >/dev/null || die "Docker is required."
command -v jq >/dev/null || die "jq is required."
docker compose version >/dev/null || die "Docker Compose v2 is required."
docker_endpoint="$(docker context inspect --format '{{ .Endpoints.docker.Host }}' 2>/dev/null)"
case "$docker_endpoint" in
  unix://* | npipe://*) ;;
  *) die "the active Docker context must use a local Unix socket or Windows named pipe." ;;
esac

compose=(
  docker compose
  -f docker-compose.yml
  -f docker-compose.contracts.yml
  -f docker-compose.load.yml
  --profile observability
)
runner_pid=""
cleaned=false
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [[ -n "$runner_pid" ]] && kill -0 "$runner_pid" 2>/dev/null; then
    kill "$runner_pid" 2>/dev/null || true
    wait "$runner_pid" 2>/dev/null || true
  fi
  if [[ "$cleaned" != true ]]; then
    "${compose[@]}" logs --no-color --tail 5000 >"$LOAD_ARTIFACT_DIR/compose.log" 2>&1 || true
    "${compose[@]}" down --volumes --remove-orphans --timeout 15 >/dev/null 2>&1 || true
    cleaned=true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

"${compose[@]}" config --quiet
"${compose[@]}" up -d --build --scale app=2 --scale worker=3 --wait web worker prometheus

container_count() {
  local containers="$1"
  wc -w <<<"$containers" | tr -d ' '
}

# `docker compose ps -q` intentionally omits successful one-shot services. Inspect all project
# containers so migrations and bucket initialization remain ownership-fenced, while separately
# proving that every long-running replica is present and healthy.
owned_containers="$("${compose[@]}" ps -aq)"
[[ "$(container_count "$owned_containers")" == 13 ]] ||
  die "the disposable Compose project does not contain exactly 13 expected containers."
for service in web postgres redis minio minio-init migrate mock-provider prometheus; do
  service_containers="$("${compose[@]}" ps -aq "$service")"
  [[ "$(container_count "$service_containers")" == 1 ]] ||
    die "the disposable Compose project does not contain exactly one $service container."
done
[[ "$(container_count "$("${compose[@]}" ps -q --status running app)")" == 2 ]] ||
  die "the disposable Compose project does not contain exactly two running API replicas."
[[ "$(container_count "$("${compose[@]}" ps -q --status running worker)")" == 3 ]] ||
  die "the disposable Compose project does not contain exactly three running worker replicas."
for container in $owned_containers; do
  actual_project="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$container")"
  load_owned="$(docker inspect -f '{{ index .Config.Labels "com.dg-chat.load-owned" }}' "$container")"
  [[ "$actual_project" == "$COMPOSE_PROJECT_NAME" && "$load_owned" == "true" ]] ||
    die "container ownership labels do not match the disposable project."
done
actual_database="$("${compose[@]}" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'select current_database()')"
[[ "$actual_database" == "$POSTGRES_DB" ]] ||
  die "PostgreSQL did not select the generated load database."

# Exercise durable recovery from a real backlog: the API replicas remain available while every
# worker is stopped. The runner publishes a marker only after it has transactionally enqueued work.
"${compose[@]}" stop --timeout 15 worker
if [[ -n "$("${compose[@]}" ps -q --status running worker)" ]]; then
  die "worker replicas did not stop before the durable queue phase."
fi

deno run \
  --allow-env \
  --allow-net=127.0.0.1,localhost \
  --allow-read="$ROOT" \
  --allow-write="$LOAD_ARTIFACT_DIR" \
  tests/load/runner.ts >"$LOAD_ARTIFACT_DIR/runner.log" 2>&1 &
runner_pid=$!

case "$profile" in
  ci) marker_timeout=600 ;;
  standard) marker_timeout=900 ;;
  scheduled) marker_timeout=1500 ;;
esac

streams_deadline=$((SECONDS + marker_timeout))
while [[ ! -f "$LOAD_ARTIFACT_DIR/streams-active.json" ]]; do
  if ! kill -0 "$runner_pid" 2>/dev/null; then
    wait "$runner_pid"
    die "load runner exited before API chaos; inspect runner.log."
  fi
  (( SECONDS < streams_deadline )) || die "timed out waiting for active streams."
  sleep 0.1
done

app_containers="$("${compose[@]}" ps -q app)"
[[ "$(wc -w <<<"$app_containers" | tr -d ' ')" == 2 ]] ||
  die "expected exactly two API replicas before rolling restart."
for container in $app_containers; do
  docker exec "$container" busybox wget -q -O /dev/null http://127.0.0.1:8000/health ||
    die "direct API replica probe failed before restart."
done
restarted_container="$(head -n 1 <<<"$app_containers")"
docker restart --time 2 "$restarted_container" >/dev/null
restart_deadline=$((SECONDS + 60))
until [[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
  "$restarted_container")" == "healthy" ]]; do
  (( SECONDS < restart_deadline )) || die "restarted API replica did not become healthy."
  sleep 0.25
done
for container in $app_containers; do
  docker exec "$container" busybox wget -q -O /dev/null http://127.0.0.1:8000/health ||
    die "direct API replica probe failed after restart."
done
jq -n --arg restartedContainer "$restarted_container" \
  '{restartedContainer:$restartedContainer,directReplicaProbes:2}' \
  >"$LOAD_ARTIFACT_DIR/api-chaos-complete.json"

marker_deadline=$((SECONDS + marker_timeout))
while [[ ! -f "$LOAD_ARTIFACT_DIR/queue-enqueued.json" ]]; do
  if ! kill -0 "$runner_pid" 2>/dev/null; then
    wait "$runner_pid"
    die "load runner exited before queue recovery; inspect runner.log."
  fi
  (( SECONDS < marker_deadline )) || die "timed out waiting for the queue phase."
  sleep 1
done

crash_job_id="$(jq -r '.crashJobId' "$LOAD_ARTIFACT_DIR/queue-enqueued.json")"
[[ "$crash_job_id" =~ ^[0-9a-f-]{36}$ ]] || die "queue marker has an invalid crash job id."
"${compose[@]}" up -d --scale worker=3 --wait worker
claim_deadline=$((SECONDS + 90))
old_claim_token=""
while [[ -z "$old_claim_token" ]]; do
  old_claim_token="$("${compose[@]}" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "select coalesce(locked_by,'') from jobs where id='$crash_job_id' and status='running'" |
    tr -d '\r')"
  if ! kill -0 "$runner_pid" 2>/dev/null; then
    wait "$runner_pid"
    die "load runner exited before a worker claimed the crash target."
  fi
  (( SECONDS < claim_deadline )) || die "no worker claimed the crash target before timeout."
  [[ -n "$old_claim_token" ]] || sleep 0.1
done
claim_instance="$(cut -d: -f2 <<<"$old_claim_token")"
[[ "$claim_instance" =~ ^[0-9a-f-]{36}$ ]] || die "worker claim token lacked an instance identity."
killed_worker=""
for container in $("${compose[@]}" ps -q worker); do
  instance="$(docker exec "$container" sh -c 'cat /tmp/dg-chat-worker-instance' 2>/dev/null || true)"
  if [[ "$instance" == "$claim_instance" ]]; then
    killed_worker="$container"
    break
  fi
done
[[ -n "$killed_worker" ]] || die "could not map the real claim owner to a worker container."
docker kill --signal KILL "$killed_worker" >/dev/null
"${compose[@]}" up -d --scale worker=3 --wait worker
jq -n \
  --arg killedContainer "$killed_worker" \
  --arg killedInstance "$claim_instance" \
  --arg oldClaimToken "$old_claim_token" \
  '{killedContainer:$killedContainer,killedInstance:$killedInstance,oldClaimToken:$oldClaimToken}' \
  >"$LOAD_ARTIFACT_DIR/worker-chaos-complete.json"

wait "$runner_pid"
runner_pid=""

jq -e '
  .schemaVersion == 2 and .passed == true and
  ([.phases[].name] | sort) ==
    (["live-stream-restart-disconnect-replay","hot-row-immutable-edit-convergence",
      "scarce-credit-accounting-contention","claimed-backlog-lease-recovery"] | sort) and
  all(.phases[]; .passed == true)
' "$LOAD_ARTIFACT_DIR/summary.json" >/dev/null

echo "Load profile '$profile' passed. Artifact: $LOAD_ARTIFACT_DIR/summary.json"
