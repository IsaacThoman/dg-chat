#!/usr/bin/env bash
set -euo pipefail

worker_id="$(docker compose "$@" ps -q worker)"
if [[ -z "$worker_id" ]]; then
  echo "worker container was not created" >&2
  exit 1
fi

health=""
for _ in {1..30}; do
  state="$(docker inspect --format '{{.State.Status}}' "$worker_id")"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$worker_id")"
  if [[ "$state" == "running" && "$health" == "healthy" ]]; then
    break
  fi
  if [[ "$state" == "exited" || "$state" == "dead" ]]; then
    echo "worker entered terminal state: $state" >&2
    docker logs "$worker_id" >&2
    exit 1
  fi
  sleep 2
done

if [[ "$health" != "healthy" ]]; then
  echo "worker did not become healthy (health=$health)" >&2
  docker inspect "$worker_id" >&2
  docker logs "$worker_id" >&2
  exit 1
fi

restart_count="$(docker inspect --format '{{.RestartCount}}' "$worker_id")"
if [[ "$restart_count" != "0" ]]; then
  echo "worker restarted during startup (restart_count=$restart_count)" >&2
  docker logs "$worker_id" >&2
  exit 1
fi

worker_env="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$worker_id")"
for name in S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY S3_SECRET_KEY S3_FORCE_PATH_STYLE; do
  if ! grep -q "^${name}=." <<<"$worker_env"; then
    echo "worker is missing required object-storage environment: $name" >&2
    exit 1
  fi
done

echo "worker is healthy and started without restarts"
