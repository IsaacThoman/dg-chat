#!/usr/bin/env bash
set -euo pipefail

api_url="${CONTRACT_API_URL:-http://localhost:8000}"
web_origin="${CONTRACT_WEB_ORIGIN:-$api_url}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-$api_url/v1}"

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  setup_token="${SETUP_TOKEN:-contract-setup-token}"
  admin_email="${CONTRACT_ADMIN_EMAIL:-contracts@dg-chat.invalid}"
  admin_password="${CONTRACT_ADMIN_PASSWORD:-Contract-Password-42!}"

  bootstrap_status="$(curl --silent --show-error --output /tmp/dg-chat-contract-bootstrap.json \
    --write-out '%{http_code}' --request POST "$api_url/api/setup/bootstrap" \
    --header 'content-type: application/json' --header "x-setup-token: $setup_token" \
    --data "{\"name\":\"Contract Administrator\",\"email\":\"$admin_email\",\"password\":\"$admin_password\"}")"
  if [[ "$bootstrap_status" != "201" && "$bootstrap_status" != "409" ]]; then
    echo "contract bootstrap failed with HTTP $bootstrap_status" >&2
    cat /tmp/dg-chat-contract-bootstrap.json >&2
    exit 1
  fi

  cookie_jar="${CONTRACT_COOKIE_JAR:-/tmp/dg-chat-contract-cookies.txt}"
  curl --fail --silent --show-error --cookie-jar "$cookie_jar" --request POST \
    "$api_url/api/auth/sign-in/email" --header 'content-type: application/json' \
    --data "{\"email\":\"$admin_email\",\"password\":\"$admin_password\"}" >/dev/null

  export OPENAI_API_KEY="$(curl --fail --silent --show-error --request POST \
    "$api_url/api/tokens" --header 'content-type: application/json' --header "origin: $web_origin" \
    --cookie "$cookie_jar" \
    --data '{"name":"Official SDK contracts","scopes":["models:read","chat:write","files:read"]}' | jq --raw-output '.token')"
fi

if [[ -z "$OPENAI_API_KEY" || "$OPENAI_API_KEY" == "null" ]]; then
  echo "OPENAI_API_KEY was not supplied or provisioned" >&2
  exit 1
fi

echo "Explicitly unsupported contract TODOs:"
jq --raw-output '.[] | "TODO  \(.endpoint): \(.reason)"' \
  tests/contracts/unsupported-contracts.json

deno run --no-config --allow-env --allow-net \
  tests/contracts/openai-javascript.ts

venv="${CONTRACT_PYTHON_VENV:-/tmp/dg-chat-openai-contract-venv}"
python3 -m venv "$venv"
"$venv/bin/python" -m pip install --quiet --disable-pip-version-check openai==2.15.0
"$venv/bin/python" tests/contracts/openai_python.py
