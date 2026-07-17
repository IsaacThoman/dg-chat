#!/usr/bin/env bash
set -euo pipefail

compose=(docker compose "$@")
prometheus_origin="http://127.0.0.1:${PROMETHEUS_HOST_PORT:-9090}"
public_origin="http://127.0.0.1:${WEB_HOST_PORT:-8000}"
public_metrics_response="$(mktemp)"

dump_failure() {
  "${compose[@]}" ps >&2 || true
  "${compose[@]}" logs --no-color prometheus app worker >&2 || true
}
cleanup() {
  local status=$?
  trap - EXIT
  rm -f "$public_metrics_response"
  if (( status != 0 )); then dump_failure; fi
  exit "$status"
}
trap cleanup EXIT

prometheus_query() {
  local expression="$1"
  curl --fail --silent --show-error --get \
    --data-urlencode "query=$expression" \
    "$prometheus_origin/api/v1/query"
}

wait_for_query_value() {
  local expression="$1"
  local expected="$2"
  local description="$3"
  local payload value
  for _attempt in $(seq 1 60); do
    payload="$(prometheus_query "$expression" 2>/dev/null || true)"
    value="$(jq -r '.data.result[0].value[1] // empty' <<<"$payload" 2>/dev/null || true)"
    if [[ "$value" == "$expected" ]]; then
      return
    fi
    sleep 2
  done
  echo "$description did not reach $expected for query: $expression" >&2
  prometheus_query "$expression" >&2 || true
  exit 1
}

wait_for_active_target_count() {
  local job="$1"
  local expected="$2"
  local payload value
  for _attempt in $(seq 1 60); do
    payload="$(
      curl --fail --silent --show-error \
        "$prometheus_origin/api/v1/targets?state=active" 2>/dev/null || true
    )"
    value="$(
      jq -r --arg job "$job" \
        '[.data.activeTargets[]? | select(.labels.job == $job)] | length' \
        <<<"$payload" 2>/dev/null || true
    )"
    if [[ "$value" == "$expected" ]]; then
      return
    fi
    sleep 2
  done
  echo "Prometheus active target count for $job did not reach $expected" >&2
  curl --fail --silent --show-error \
    "$prometheus_origin/api/v1/targets?state=active" >&2 || true
  exit 1
}

healthy_count() {
  local service="$1"
  local count=0
  local id state health
  for id in $("${compose[@]}" ps --quiet "$service"); do
    state="$(docker inspect --format '{{.State.Status}}' "$id")"
    health="$(docker inspect --format \
      '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$id")"
    if [[ "$state" == "running" && "$health" == "healthy" ]]; then
      count=$((count + 1))
    fi
  done
  printf '%s' "$count"
}

"${compose[@]}" --profile observability up -d --scale app=2 --scale worker=2 \
  app worker web prometheus

for _attempt in $(seq 1 90); do
  app_healthy="$(healthy_count app)"
  worker_healthy="$(healthy_count worker)"
  if [[ "$app_healthy" == "2" && "$worker_healthy" == "2" ]]; then
    break
  fi
  sleep 2
done
if [[ "${app_healthy:-0}" != "2" || "${worker_healthy:-0}" != "2" ]]; then
  echo "scaled API/worker replicas did not become healthy" >&2
  exit 1
fi

for _attempt in $(seq 1 60); do
  if curl --fail --silent "$prometheus_origin/-/ready" >/dev/null; then
    break
  fi
  sleep 2
done
curl --fail --silent --show-error "$prometheus_origin/-/ready" >/dev/null

wait_for_query_value 'count(up{job="dg-chat-api"} == 1)' "2" \
  "Prometheus API replica discovery"
wait_for_query_value 'count(up{job="dg-chat-worker"} == 1)' "2" \
  "Prometheus worker replica discovery"

rules="$(
  curl --fail --silent --show-error \
    "$prometheus_origin/api/v1/rules?type=alert"
)"
for alert in \
  DgChatTargetDown \
  DgChatApiTargetsAbsent \
  DgChatWorkerTargetsAbsent \
  DgChatQueueStalled
do
  jq -e --arg alert "$alert" \
    '[.data.groups[].rules[] | select(.name == $alert)] | length == 1' \
    <<<"$rules" >/dev/null
done

compose_model="$("${compose[@]}" --profile observability config --format json)"
jq -e '
  ((.services.app.ports // []) | length) == 0 and
  ((.services.worker.ports // []) | length) == 0 and
  .services.prometheus.ports[0].host_ip == "127.0.0.1"
' <<<"$compose_model" >/dev/null

metrics_status="$(
  curl --silent --output "$public_metrics_response" \
    --write-out '%{http_code}' "$public_origin/metrics"
)"
if [[ "$metrics_status" != "404" ]]; then
  echo "public reverse proxy unexpectedly exposed /metrics (status=$metrics_status)" >&2
  exit 1
fi
if grep -q 'dg_chat_' "$public_metrics_response"; then
  echo "public /metrics response contained exporter data" >&2
  exit 1
fi
if curl --fail --silent --max-time 2 http://127.0.0.1:9091/metrics >/dev/null 2>&1; then
  echo "worker metrics exporter is reachable through a host port" >&2
  exit 1
fi

# Removing every worker makes DNS discovery remove the active target set entirely. Query the
# target-discovery API because Prometheus deliberately retains the final `up=0` sample for its
# lookback window; waiting on `absent(up{...})` would make this smoke test timing-dependent.
"${compose[@]}" stop worker >/dev/null
wait_for_active_target_count "dg-chat-worker" "0"
wait_for_query_value 'sum(up{job="dg-chat-worker"}) or vector(0)' "0" \
  "Prometheus zero-healthy-worker detection"

echo "observability profile acceptance passed"
