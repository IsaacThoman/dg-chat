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
# shellcheck source=tests/load/host-commands.sh
source "$ROOT/tests/load/host-commands.sh"

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
command -v curl >/dev/null || die "curl is required."
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

assert_loopback_port() {
  local service="$1"
  local target_port="$2"
  local expected_port="$3"
  local published
  published="$("${compose[@]}" port "$service" "$target_port" 2>/dev/null)" ||
    die "$service does not expose its load-harness endpoint."
  [[ "$published" == "127.0.0.1:${expected_port}" ]] ||
    die "$service is not published on the expected loopback-only port."
}
assert_loopback_port web 8080 "$LOAD_WEB_HOST_PORT"
assert_loopback_port postgres 5432 "$LOAD_POSTGRES_HOST_PORT"
assert_loopback_port mock-provider 4010 "$LOAD_MOCK_HOST_PORT"
assert_loopback_port prometheus 9090 "$LOAD_PROMETHEUS_HOST_PORT"

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
active_streams="$(jq -r '.activeStreams // 0' "$LOAD_ARTIFACT_DIR/streams-active.json")"
[[ "$active_streams" =~ ^[0-9]+$ ]] && ((active_streams >= 1)) ||
  die "stream marker did not prove an open response body."

app_containers="$("${compose[@]}" ps -q app)"
[[ "$(wc -w <<<"$app_containers" | tr -d ' ')" == 2 ]] ||
  die "expected exactly two API replicas before rolling restart."
for container in $app_containers; do
  docker exec "$container" busybox wget -q -O /dev/null http://127.0.0.1:8000/health ||
    die "direct API replica probe failed before restart."
done

# Prometheus scrapes each API replica directly. Select a container whose own in-flight gauge proves
# it currently owns a streaming POST, then restart that exact replica rather than an arbitrary one.
active_metric_instance=""
active_requests_before_restart=""
restarted_container=""
metric_deadline=$((SECONDS + 30))
while [[ -z "$restarted_container" ]]; do
  metrics_response="$(curl --fail --silent --show-error --get \
    --data-urlencode \
    'query=dg_chat_http_requests_in_flight{job="dg-chat-api",method="POST",route="api"} > 0' \
    "$LOAD_PROMETHEUS_URL/api/v1/query")" ||
    die "could not query Prometheus for active API streams."
  while IFS=$'\t' read -r candidate_instance candidate_value; do
    [[ -n "$candidate_instance" && "$candidate_value" =~ ^[0-9]+([.][0-9]+)?$ ]] || continue
    candidate_ip="${candidate_instance%:*}"
    for container in $app_containers; do
      if docker inspect -f '{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}' \
        "$container" | grep -Fxq "$candidate_ip"; then
        active_metric_instance="$candidate_instance"
        active_requests_before_restart="$candidate_value"
        restarted_container="$container"
        break 2
      fi
    done
  done < <(jq -r '.data.result[]? | [.metric.instance, .value[1]] | @tsv' <<<"$metrics_response")
  (( SECONDS < metric_deadline )) ||
    die "Prometheus never identified an API replica with an active streaming request."
  [[ -n "$restarted_container" ]] || sleep 0.1
done
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
api_marker_tmp="$LOAD_ARTIFACT_DIR/.api-chaos-complete.$$.tmp"
jq -n \
  --arg restartedContainer "$restarted_container" \
  --arg activeMetricInstance "$active_metric_instance" \
  --argjson activeRequestsBeforeRestart "$active_requests_before_restart" \
  --argjson markerActiveStreams "$active_streams" \
  '{
    restartedContainer:$restartedContainer,
    activeMetricInstance:$activeMetricInstance,
    activeRequestsBeforeRestart:$activeRequestsBeforeRestart,
    markerActiveStreams:$markerActiveStreams,
    directReplicaProbes:2
  }' \
  >"$api_marker_tmp"
mv "$api_marker_tmp" "$LOAD_ARTIFACT_DIR/api-chaos-complete.json"

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
worker_chaos_stage="start-workers"
old_claim_token=""
claim_instance=""
killed_worker=""

capture_worker_chaos_diagnostics() {
  local reason="$1"
  local diagnostics_tmp="$LOAD_ARTIFACT_DIR/.worker-chaos-diagnostics.$$.tmp"
  {
    printf 'stage=%s\nreason=%s\nobservedAt=%s\n' \
      "$worker_chaos_stage" "$reason" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    bounded_host_command 8 "snapshot crash target state" \
      "${compose[@]}" exec -T \
      -e PGCONNECT_TIMEOUT=3 \
      -e PGOPTIONS=-c\ statement_timeout=5000 \
      postgres psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      -c "select json_build_object(
        'id',id,'status',status,'attempts',attempts,'lockedBy',locked_by,
        'lockedAt',locked_at,'availableAt',available_at,'observedAt',clock_timestamp()
      ) from jobs where id='$crash_job_id'" || true
    bounded_host_command 8 "snapshot worker replica state" \
      "${compose[@]}" ps worker || true
    bounded_host_command 8 "snapshot worker logs" \
      "${compose[@]}" logs --no-color --tail 120 worker || true
  } >"$diagnostics_tmp" 2>&1
  mv "$diagnostics_tmp" "$LOAD_ARTIFACT_DIR/worker-chaos-diagnostics.log"
}

publish_worker_chaos_failure() {
  local reason="$1"
  local failure_tmp="$LOAD_ARTIFACT_DIR/.worker-chaos-failed.$$.tmp"
  jq -n \
    --arg stage "$worker_chaos_stage" \
    --arg reason "$reason" \
    --arg crashJobId "$crash_job_id" \
    --arg claimInstance "$claim_instance" \
    --arg killedContainer "$killed_worker" \
    '{
      stage:$stage,
      reason:$reason,
      crashJobId:$crashJobId,
      claimInstance:($claimInstance | if length > 0 then . else null end),
      killedContainer:($killedContainer | if length > 0 then . else null end),
      diagnostics:"worker-chaos-diagnostics.log"
    }' >"$failure_tmp"
  mv "$failure_tmp" "$LOAD_ARTIFACT_DIR/worker-chaos-failed.json"
}

fail_worker_chaos() {
  local reason="$1"
  capture_worker_chaos_diagnostics "$reason"
  publish_worker_chaos_failure "$reason"
  cat "$LOAD_ARTIFACT_DIR/worker-chaos-diagnostics.log" >&2
  die "$reason"
}

# The exact three worker containers were stopped above; starting them in place avoids spending the
# deliberately short claim-stall window recreating dependencies. Do not wait for health before
# observing the claim: the worker's real five-second PostgreSQL statement timeout is part of the
# invariant, so the runner keeps its injected statement below that limit.
# Compose starts stopped replicas serially and waits for each container's health transition before
# moving to the next one. Three healthy replicas can legitimately take more than 15 seconds on a
# cold or contended CI host, so keep this operation bounded above the aggregate health-start budget.
if ! bounded_host_command 45 "start worker replicas for crash claim" \
  "${compose[@]}" start worker; then
  fail_worker_chaos "worker replicas did not start within the 45-second host bound."
fi
worker_chaos_stage="observe-claim"
claim_deadline=$((SECONDS + 45))
while [[ -z "$old_claim_token" ]]; do
  if ! old_claim_token="$(bounded_host_command 5 "read crash target claim" \
    "${compose[@]}" exec -T \
    -e PGCONNECT_TIMEOUT=3 \
    -e PGOPTIONS=-c\ statement_timeout=3000 \
    postgres psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "select coalesce(locked_by,'') from jobs where id='$crash_job_id' and status='running'" |
    tr -d '\r')"; then
    fail_worker_chaos "the bounded crash-target claim query failed."
  fi
  if ! kill -0 "$runner_pid" 2>/dev/null; then
    wait "$runner_pid" || true
    fail_worker_chaos "load runner exited before a worker claimed the crash target."
  fi
  if ((SECONDS >= claim_deadline)); then
    fail_worker_chaos "no worker claimed the crash target within the 45-second recovery bound."
  fi
  [[ -n "$old_claim_token" ]] || sleep 0.1
done
claim_instance="$(cut -d: -f2 <<<"$old_claim_token")"
[[ "$claim_instance" =~ ^[0-9a-f-]{36}$ ]] ||
  fail_worker_chaos "worker claim token lacked an instance identity."
worker_chaos_stage="map-claim-owner"
if ! worker_containers="$(bounded_host_command 8 "list worker replicas for claim mapping" \
  "${compose[@]}" ps -q worker)"; then
  fail_worker_chaos "worker replicas could not be listed for claim-owner mapping."
fi
for container in $worker_containers; do
  if ! instance="$(bounded_host_command 5 "read worker instance identity" \
    docker exec "$container" sh -c 'cat /tmp/dg-chat-worker-instance')"; then
    instance=""
  fi
  if [[ "$instance" == "$claim_instance" ]]; then
    killed_worker="$container"
    break
  fi
done
[[ -n "$killed_worker" ]] ||
  fail_worker_chaos "could not map the real claim owner to a worker container."
worker_chaos_stage="kill-claim-owner"
if ! bounded_host_command 15 "kill real crash target claim owner" \
  docker kill --signal KILL "$killed_worker" >/dev/null; then
  fail_worker_chaos "the real claim owner did not stop within the 15-second host bound."
fi
worker_chaos_stage="restore-worker-capacity"
if ! bounded_host_command 75 "restore killed worker replica" \
  "${compose[@]}" up -d --scale worker=3 --wait --wait-timeout 60 worker; then
  fail_worker_chaos "worker capacity did not recover within the 75-second health bound."
fi
worker_chaos_stage="publish-success"
worker_marker_tmp="$LOAD_ARTIFACT_DIR/.worker-chaos-complete.$$.tmp"
if ! jq -n \
  --arg killedContainer "$killed_worker" \
  --arg killedInstance "$claim_instance" \
  --arg oldClaimToken "$old_claim_token" \
  '{killedContainer:$killedContainer,killedInstance:$killedInstance,oldClaimToken:$oldClaimToken}' \
  >"$worker_marker_tmp" ||
  ! mv "$worker_marker_tmp" "$LOAD_ARTIFACT_DIR/worker-chaos-complete.json"; then
  fail_worker_chaos "the atomic worker-chaos success marker could not be published."
fi

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
