#!/usr/bin/env bash
set -euo pipefail

compose=(docker compose "$@")

container_id() {
  local service="$1"
  local id
  # One-shot initialization services have already exited by the time readiness succeeds.
  # Compose omits stopped containers from `ps -q` unless `--all` is explicit.
  id="$("${compose[@]}" ps --all --quiet "$service")"
  if [[ -z "$id" ]]; then
    echo "$service container was not created" >&2
    exit 1
  fi
  printf '%s' "$id"
}

dump_failure() {
  local service="$1"
  local id="$2"
  docker inspect --format \
    'service='"$service"' status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{json .State.Error}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}} restarts={{.RestartCount}} started={{.State.StartedAt}} finished={{.State.FinishedAt}}' \
    "$id" >&2 || true
  "${compose[@]}" logs --no-color "$service" >&2 || true
}

wait_healthy() {
  local service="$1"
  local id state health
  id="$(container_id "$service")"
  health=""
  for _ in {1..90}; do
    state="$(docker inspect --format '{{.State.Status}}' "$id")"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$id")"
    if [[ "$state" == "running" && "$health" == "healthy" ]]; then
      break
    fi
    if [[ "$state" == "exited" || "$state" == "dead" ]]; then
      echo "$service entered terminal state: $state" >&2
      dump_failure "$service" "$id"
      exit 1
    fi
    sleep 2
  done
  if [[ "$health" != "healthy" ]]; then
    echo "$service did not become healthy (health=$health)" >&2
    dump_failure "$service" "$id"
    exit 1
  fi
  assert_no_restarts "$service" "$id"
}

wait_running() {
  local service="$1"
  local id state
  id="$(container_id "$service")"
  for _ in {1..60}; do
    state="$(docker inspect --format '{{.State.Status}}' "$id")"
    if [[ "$state" == "running" ]]; then
      assert_no_restarts "$service" "$id"
      return
    fi
    if [[ "$state" == "exited" || "$state" == "dead" ]]; then
      echo "$service entered terminal state: $state" >&2
      dump_failure "$service" "$id"
      exit 1
    fi
    sleep 2
  done
  echo "$service did not enter the running state" >&2
  dump_failure "$service" "$id"
  exit 1
}

wait_completed() {
  local service="$1"
  local id state exit_code
  id="$(container_id "$service")"
  for _ in {1..90}; do
    state="$(docker inspect --format '{{.State.Status}}' "$id")"
    if [[ "$state" == "exited" ]]; then
      exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$id")"
      if [[ "$exit_code" == "0" ]]; then
        return
      fi
      echo "$service exited unsuccessfully (exit_code=$exit_code)" >&2
      dump_failure "$service" "$id"
      exit 1
    fi
    if [[ "$state" == "dead" ]]; then
      echo "$service entered terminal state: $state" >&2
      dump_failure "$service" "$id"
      exit 1
    fi
    sleep 2
  done
  echo "$service did not complete successfully" >&2
  dump_failure "$service" "$id"
  exit 1
}

assert_no_restarts() {
  local service="$1"
  local id="$2"
  local restart_count
  restart_count="$(docker inspect --format '{{.RestartCount}}' "$id")"
  if [[ "$restart_count" != "0" ]]; then
    echo "$service restarted during startup (restart_count=$restart_count)" >&2
    dump_failure "$service" "$id"
    exit 1
  fi
}

for service in postgres redis minio searxng search-proxy app worker web; do
  wait_healthy "$service"
done
for service in migrate minio-init; do
  wait_completed "$service"
done
worker_id="$(container_id worker)"
worker_env_names="$(
  docker inspect --format '{{range .Config.Env}}{{println (index (split . "=") 0)}}{{end}}' \
    "$worker_id"
)"
for name in \
  S3_ENDPOINT S3_ALLOW_INSECURE S3_REGION S3_BUCKET S3_ACCESS_KEY S3_SECRET_KEY S3_FORCE_PATH_STYLE \
  KNOWLEDGE_EMBEDDING_BASE_URL KNOWLEDGE_EMBEDDING_API_KEY KNOWLEDGE_EMBEDDING_MODEL \
  KNOWLEDGE_EMBEDDING_UPSTREAM_MODEL KNOWLEDGE_EMBEDDING_VERSION \
  KNOWLEDGE_EMBEDDING_BATCH_SIZE KNOWLEDGE_EMBEDDING_INPUT_MICROS_PER_MILLION \
  KNOWLEDGE_EMBEDDING_FIXED_CALL_MICROS; do
  if ! grep -qx "$name" <<<"$worker_env_names"; then
    echo "worker is missing required production environment: $name" >&2
    exit 1
  fi
done

web_url="${COMPOSE_HEALTH_URL:-http://127.0.0.1:${PORT:-8000}}"
curl --fail --silent --show-error "$web_url/health" >/dev/null
curl --fail --silent --show-error "$web_url/ready" >/dev/null
curl --fail --silent --show-error "$web_url/api/setup/status" >/dev/null

echo "full Compose stack is healthy, initialized, reachable, and started without restarts"
