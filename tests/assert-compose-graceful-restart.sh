#!/usr/bin/env bash
set -euo pipefail

compose=(docker compose "$@")
slack_seconds="${COMPOSE_STOP_TIMEOUT_SLACK_SECONDS:-10}"
dns_holder=""
app_recreate_needed=false

remove_dns_holder() {
  if [[ -n "$dns_holder" ]]; then
    docker rm --force "$dns_holder" >/dev/null 2>&1 || true
    dns_holder=""
  fi
}

cleanup_on_exit() {
  status=$?
  trap - EXIT
  remove_dns_holder
  if [[ "$app_recreate_needed" == "true" ]]; then
    "${compose[@]}" up -d --no-deps app >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup_on_exit EXIT

if ! [[ "$slack_seconds" =~ ^[0-9]+$ ]]; then
  echo "COMPOSE_STOP_TIMEOUT_SLACK_SECONDS must be a non-negative integer" >&2
  exit 1
fi

dump_state() {
  local service="$1"
  local id="$2"
  docker inspect --format \
    'service='"$service"' status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{json .State.Error}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}} restarts={{.RestartCount}} started={{.State.StartedAt}} finished={{.State.FinishedAt}}' \
    "$id" >&2 || true
}

resolved_app_addresses() {
  "${compose[@]}" exec -T web getent hosts app 2>/dev/null | awk '{print $1}' | LC_ALL=C sort -u
}

app_id=""
worker_id=""
maximum_grace=0
for service in app worker; do
  id="$("${compose[@]}" ps --quiet "$service")"
  if [[ -z "$id" ]]; then
    echo "$service container is not running before graceful-stop verification" >&2
    exit 1
  fi
  grace="$(
    docker inspect --format '{{if .Config.StopTimeout}}{{.Config.StopTimeout}}{{else}}0{{end}}' \
      "$id"
  )"
  if ! [[ "$grace" =~ ^[1-9][0-9]*$ ]] || (( grace > 120 )); then
    echo "$service has an invalid Compose stop grace: $grace" >&2
    dump_state "$service" "$id"
    exit 1
  fi
  case "$service" in
    app)
      app_id="$id"
      ;;
    worker)
      worker_id="$id"
      ;;
  esac
  if (( grace > maximum_grace )); then
    maximum_grace="$grace"
  fi
done

old_app_addresses="$(resolved_app_addresses)"
if [[ -z "$old_app_addresses" ]]; then
  echo "the web proxy could not resolve the app before graceful-stop verification" >&2
  exit 1
fi

# Cross a wall-clock second boundary before taking the Docker log cursor. Docker accepts
# second-precision RFC3339 values; this makes every marker that existed when the check began
# strictly older than the cursor, including a marker emitted earlier in that original second.
cursor_second="$(date +%s)"
while [[ "$(date +%s)" == "$cursor_second" ]]; do sleep 0.05; done
stop_log_cursor="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
started_at="$(date +%s)"
"${compose[@]}" stop app worker
elapsed="$(( $(date +%s) - started_at ))"
if (( elapsed > maximum_grace + slack_seconds )); then
  echo "app/worker stop exceeded Compose grace (${elapsed}s > $((maximum_grace + slack_seconds))s)" >&2
  exit 1
fi

for service in app worker; do
  case "$service" in
    app) id="$app_id" ;;
    worker) id="$worker_id" ;;
  esac
  status="$(docker inspect --format '{{.State.Status}}' "$id")"
  exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$id")"
  oom_killed="$(docker inspect --format '{{.State.OOMKilled}}' "$id")"
  state_error="$(docker inspect --format '{{.State.Error}}' "$id")"
  if [[ "$status" != "exited" || "$exit_code" != "0" || "$oom_killed" != "false" || -n "$state_error" ]]; then
    echo "$service did not stop cleanly: status=$status exit_code=$exit_code oom_killed=$oom_killed error=${state_error:-none}" >&2
    dump_state "$service" "$id"
    exit 1
  fi
  if [[ "$exit_code" == "137" ]]; then
    echo "$service was killed instead of completing graceful shutdown" >&2
    exit 1
  fi
done

app_logs="$("${compose[@]}" logs --no-color --since "$stop_log_cursor" app)"
worker_logs="$("${compose[@]}" logs --no-color --since "$stop_log_cursor" worker)"
if ! grep -Fq '"message":"API shutdown complete"' <<<"$app_logs"; then
  echo "app exited without recording a complete shutdown after $stop_log_cursor" >&2
  dump_state app "$app_id"
  exit 1
fi
if ! grep -Fq '"message":"Worker stopped"' <<<"$worker_logs"; then
  echo "worker exited without completing its shutdown path after $stop_log_cursor" >&2
  dump_state worker "$worker_id"
  exit 1
fi

"${compose[@]}" start app worker

# nginx normally outlives these services. Prove it follows the restarted app's current Compose
# address rather than retaining the address resolved when the web container first started.
web_ready=""
for _attempt in $(seq 1 30); do
  if web_ready="$(
    "${compose[@]}" exec -T web \
      wget --quiet --timeout=2 --output-document=- http://127.0.0.1:8080/ready 2>/dev/null
  )" && grep -Fq '"status":"ready"' <<<"$web_ready"; then
    break
  fi
  web_ready=""
  sleep 1
done
if [[ -z "$web_ready" ]]; then
  echo "the public web proxy did not reconnect to the restarted app" >&2
  "${compose[@]}" logs --no-color --tail 80 web app >&2 || true
  exit 1
fi

new_app_addresses="$(resolved_app_addresses)"
if [[ "$new_app_addresses" == "$old_app_addresses" ]]; then
  # Some engines retain a stopped container's address. Recreate only after graceful-shutdown
  # evidence has been collected. A short-lived holder occupies nginx's cached address so Docker
  # must place the replacement app elsewhere; this makes DNS churn deterministic instead of
  # relying on a particular engine's address-allocation order.
  current_app_id="$("${compose[@]}" ps --quiet app)"
  old_primary_address="${old_app_addresses%%$'\n'*}"
  shared_network="$(
    docker inspect --format \
      '{{range $name, $network := .NetworkSettings.Networks}}{{if eq $network.IPAddress "'"$old_primary_address"'"}}{{println $name}}{{end}}{{end}}' \
      "$current_app_id"
  )"
  web_id="$("${compose[@]}" ps --quiet web)"
  web_image="$(docker inspect --format '{{.Config.Image}}' "$web_id")"
  if [[ -z "$shared_network" || -z "$web_image" ]]; then
    echo "unable to identify the web-visible app network for DNS churn" >&2
    exit 1
  fi
  app_recreate_needed=true
  docker rm --force "$current_app_id" >/dev/null
  dns_holder="dg-chat-dns-churn-$$-$RANDOM"
  docker run --detach --rm --name "$dns_holder" \
    --label "dg-chat.test-purpose=proxy-dns-churn" --network "$shared_network" \
    --ip "$old_primary_address" --entrypoint /bin/sh "$web_image" -c 'sleep 120' >/dev/null
  "${compose[@]}" up -d --no-deps app
  new_app_addresses=""
  web_ready=""
  for _attempt in $(seq 1 30); do
    candidate_addresses="$(resolved_app_addresses)"
    if [[ -n "$candidate_addresses" && "$candidate_addresses" != "$old_app_addresses" ]] &&
      web_ready="$(
        "${compose[@]}" exec -T web \
          wget --quiet --timeout=2 --output-document=- http://127.0.0.1:8080/ready 2>/dev/null
      )" && grep -Fq '"status":"ready"' <<<"$web_ready"; then
      new_app_addresses="$candidate_addresses"
      break
    fi
    sleep 1
  done
  if [[ -n "$new_app_addresses" && "$new_app_addresses" != "$old_app_addresses" ]]; then
    app_recreate_needed=false
  fi
  remove_dns_holder
fi
if [[ -z "$new_app_addresses" || "$new_app_addresses" == "$old_app_addresses" ]]; then
  echo "the restart check did not produce a changed app service address" >&2
  echo "before=$old_app_addresses after=${new_app_addresses:-unresolved}" >&2
  exit 1
fi

echo "app and worker stopped cleanly within ${elapsed}s; nginx followed the changed app address"
