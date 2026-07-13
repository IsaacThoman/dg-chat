#!/usr/bin/env bash
set -euo pipefail

api_url="${CONTRACT_API_URL:-http://localhost:8000}"
web_origin="${CONTRACT_WEB_ORIGIN:-$api_url}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-$api_url/v1}"
compose=(docker compose -f docker-compose.yml -f docker-compose.ci.yml -f docker-compose.contracts.yml)
mock_provider_base_url="${CONTRACT_MOCK_PROVIDER_BASE_URL:-http://mock-provider:4010/v1}"
mock_control_url="${CONTRACT_MOCK_CONTROL_URL:-}"
mock_control_token="${CONTRACT_MOCK_CONTROL_TOKEN:-ci-mock-control-token}"

mock_request() {
  local method="$1"
  local path="$2"
  if [[ -n "$mock_control_url" ]]; then
    curl --fail --silent --show-error --request "$method" \
      --header "authorization: Bearer $mock_control_token" \
      "${mock_control_url%/}$path"
    return
  fi
  "${compose[@]}" exec -T mock-provider deno eval \
    "fetch('http://127.0.0.1:4010$path',{method:'$method',headers:{authorization:'Bearer $mock_control_token'}}).then(async r=>{const body=await r.text();console.log(body);if(!r.ok)Deno.exit(1)})"
}

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  setup_token="${SETUP_TOKEN:-contract-setup-token}"
  admin_email="${CONTRACT_ADMIN_EMAIL:-contracts@dg-chat.invalid}"
  admin_password="${CONTRACT_ADMIN_PASSWORD:-Contract-Password-42!}"

  setup_status="$(curl --fail --silent --show-error "$api_url/api/setup/status")"
  if [[ "$(jq --raw-output '.bootstrapRequired' <<<"$setup_status")" != "true" ]]; then
    echo "contract stack is not clean: an administrator already exists; use a fresh Compose project or remove its volumes" >&2
    exit 1
  fi

  bootstrap_status="$(curl --silent --show-error --output /tmp/dg-chat-contract-bootstrap.json \
    --write-out '%{http_code}' --request POST "$api_url/api/setup/bootstrap" \
    --header 'content-type: application/json' --header "x-setup-token: $setup_token" \
    --data "{\"name\":\"Contract Administrator\",\"email\":\"$admin_email\",\"password\":\"$admin_password\"}")"
  if [[ "$bootstrap_status" != "201" ]]; then
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
    --data '{"name":"Official SDK contracts","scopes":["models:read","chat:write","files:read","files:write"],"rpmLimit":60000,"burstLimit":1000}' | jq --raw-output '.token')"
  export CONTRACT_SESSION_COOKIE="$(
    awk 'NF >= 7 && ($0 !~ /^#/ || $0 ~ /^#HttpOnly_/) { value=$6 "=" $7 } END { print value }' \
      "$cookie_jar"
  )"
fi

if [[ -z "$OPENAI_API_KEY" || "$OPENAI_API_KEY" == "null" ]]; then
  echo "OPENAI_API_KEY was not supplied or provisioned" >&2
  exit 1
fi

if [[ -z "${CONTRACT_SESSION_COOKIE:-}" ]]; then
  echo "CONTRACT_SESSION_COOKIE is required when supplying OPENAI_API_KEY externally" >&2
  exit 1
fi

create_contract_token() {
  local name="$1"
  local rpm_limit="$2"
  local burst_limit="$3"
  curl --fail --silent --show-error --request POST \
    "$api_url/api/tokens" --header 'content-type: application/json' --header "origin: $web_origin" \
    --cookie "$CONTRACT_SESSION_COOKIE" \
    --data "$(jq --null-input --compact-output --arg name "$name" \
      --argjson rpmLimit "$rpm_limit" --argjson burstLimit "$burst_limit" \
      '{name:$name,scopes:["models:read","chat:write"],rpmLimit:$rpmLimit,burstLimit:$burstLimit}')" |
    jq --raw-output '.token'
}

export CONTRACT_JS_RATE_API_KEY="${CONTRACT_JS_RATE_API_KEY:-$(
  create_contract_token "JavaScript rate-limit contract" 1 1
)}"
export CONTRACT_PYTHON_RATE_API_KEY="${CONTRACT_PYTHON_RATE_API_KEY:-$(
  create_contract_token "Python rate-limit contract" 1 1
)}"

if [[ -z "${CONTRACT_EMPTY_CREDIT_API_KEY:-}" ]]; then
  empty_suffix="$(date +%s)-$$"
  empty_email="empty-credit-$empty_suffix@dg-chat.invalid"
  empty_password='Contract-Empty-Credit-42!'
  empty_cookie_jar="/tmp/dg-chat-empty-credit-$empty_suffix.cookies"
  empty_signup="$(curl --fail --silent --show-error --request POST \
    "$api_url/api/auth/sign-up/email" --header 'content-type: application/json' \
    --header "origin: $web_origin" \
    --data "$(jq --null-input --compact-output --arg email "$empty_email" \
      --arg password "$empty_password" \
      '{name:"Empty Credit Contract",email:$email,password:$password}')")"
  empty_user_id="$(jq --raw-output '.user.id' <<<"$empty_signup")"
  curl --fail --silent --show-error --request PATCH \
    "$api_url/api/admin/users/$empty_user_id/approval" --header 'content-type: application/json' \
    --header "origin: $web_origin" --cookie "$CONTRACT_SESSION_COOKIE" \
    --data '{"status":"approved","startingCreditMicros":0}' >/dev/null
  curl --fail --silent --show-error --cookie-jar "$empty_cookie_jar" --request POST \
    "$api_url/api/auth/sign-in/email" --header 'content-type: application/json' \
    --header "origin: $web_origin" \
    --data "$(jq --null-input --compact-output --arg email "$empty_email" \
      --arg password "$empty_password" '{email:$email,password:$password}')" >/dev/null
  export CONTRACT_EMPTY_CREDIT_API_KEY="$(curl --fail --silent --show-error --request POST \
    "$api_url/api/tokens" --header 'content-type: application/json' --header "origin: $web_origin" \
    --cookie "$empty_cookie_jar" \
    --data '{"name":"Insufficient credit contract","scopes":["chat:write"]}' |
    jq --raw-output '.token')"
  rm -f "$empty_cookie_jar"
fi

mock_request POST /__test/reset >/dev/null

provider="$(curl --fail --silent --show-error --request POST \
  "$api_url/api/admin/providers" --header 'content-type: application/json' \
  --header "origin: $web_origin" --cookie "$CONTRACT_SESSION_COOKIE" \
  --data "$(jq --null-input --compact-output --arg baseUrl "$mock_provider_base_url" \
    '{slug:"contracts",displayName:"Contract Mock Provider",baseUrl:$baseUrl,protocol:"chat_completions"}')")"
provider_id="$(jq --raw-output '.id' <<<"$provider")"
provider_version="$(jq --raw-output '.version' <<<"$provider")"
provider="$(curl --fail --silent --show-error --request PUT \
  "$api_url/api/admin/providers/$provider_id/credential" --header 'content-type: application/json' \
  --header "origin: $web_origin" --cookie "$CONTRACT_SESSION_COOKIE" \
  --data "{\"expectedVersion\":$provider_version,\"credential\":\"ci-mock-provider-key\"}")"
model="$(curl --fail --silent --show-error --request POST \
  "$api_url/api/admin/models" --header 'content-type: application/json' \
  --header "origin: $web_origin" --cookie "$CONTRACT_SESSION_COOKIE" \
  --data "{\"providerId\":\"$provider_id\",\"publicModelId\":\"contracts/mock-embedding\",\"upstreamModelId\":\"mock-embedding\",\"displayName\":\"Contract Mock Embedding\",\"capabilities\":[\"embeddings\"],\"contextWindow\":8192}")"
model_id="$(jq --raw-output '.id' <<<"$model")"
model_version="$(jq --raw-output '.version' <<<"$model")"
curl --fail --silent --show-error --request POST \
  "$api_url/api/admin/models/$model_id/prices" --header 'content-type: application/json' \
  --header "origin: $web_origin" --cookie "$CONTRACT_SESSION_COOKIE" \
  --data "{\"providerModelId\":\"$model_id\",\"expectedModelVersion\":$model_version,\"effectiveAt\":\"2020-01-01T00:00:00.000Z\",\"inputMicrosPerMillion\":100000,\"cachedInputMicrosPerMillion\":100000,\"reasoningMicrosPerMillion\":0,\"outputMicrosPerMillion\":0,\"fixedCallMicros\":10,\"source\":\"contract\"}" >/dev/null

audio_model="$(curl --fail --silent --show-error --request POST \
  "$api_url/api/admin/models" --header 'content-type: application/json' \
  --header "origin: $web_origin" --cookie "$CONTRACT_SESSION_COOKIE" \
  --data "{\"providerId\":\"$provider_id\",\"publicModelId\":\"contracts/mock-transcribe\",\"upstreamModelId\":\"mock-transcribe\",\"displayName\":\"Contract Mock Audio\",\"capabilities\":[\"transcription\",\"translation\",\"speech\"],\"contextWindow\":8192}")"
audio_model_id="$(jq --raw-output '.id' <<<"$audio_model")"
audio_model_version="$(jq --raw-output '.version' <<<"$audio_model")"
curl --fail --silent --show-error --request POST \
  "$api_url/api/admin/models/$audio_model_id/prices" --header 'content-type: application/json' \
  --header "origin: $web_origin" --cookie "$CONTRACT_SESSION_COOKIE" \
  --data "{\"providerModelId\":\"$audio_model_id\",\"expectedModelVersion\":$audio_model_version,\"effectiveAt\":\"2020-01-01T00:00:00.000Z\",\"inputMicrosPerMillion\":0,\"cachedInputMicrosPerMillion\":0,\"reasoningMicrosPerMillion\":0,\"outputMicrosPerMillion\":0,\"fixedCallMicros\":10,\"source\":\"contract\"}" >/dev/null

image_model="$(curl --fail --silent --show-error --request POST \
  "$api_url/api/admin/models" --header 'content-type: application/json' \
  --header "origin: $web_origin" --cookie "$CONTRACT_SESSION_COOKIE" \
  --data "{\"providerId\":\"$provider_id\",\"publicModelId\":\"contracts/mock-image\",\"upstreamModelId\":\"mock-image\",\"displayName\":\"Contract Mock Image\",\"capabilities\":[\"image_generation\",\"image_editing\"],\"contextWindow\":8192}")"
image_model_id="$(jq --raw-output '.id' <<<"$image_model")"
image_model_version="$(jq --raw-output '.version' <<<"$image_model")"
curl --fail --silent --show-error --request POST \
  "$api_url/api/admin/models/$image_model_id/prices" --header 'content-type: application/json' \
  --header "origin: $web_origin" --cookie "$CONTRACT_SESSION_COOKIE" \
  --data "{\"providerModelId\":\"$image_model_id\",\"expectedModelVersion\":$image_model_version,\"effectiveAt\":\"2020-01-01T00:00:00.000Z\",\"inputMicrosPerMillion\":0,\"cachedInputMicrosPerMillion\":0,\"reasoningMicrosPerMillion\":0,\"outputMicrosPerMillion\":0,\"fixedCallMicros\":1000,\"source\":\"contract\"}" >/dev/null

responses_provider="$(curl --fail --silent --show-error --request POST \
  "$api_url/api/admin/providers" --header 'content-type: application/json' \
  --header "origin: $web_origin" --cookie "$CONTRACT_SESSION_COOKIE" \
  --data "$(jq --null-input --compact-output --arg baseUrl "$mock_provider_base_url" \
    '{slug:"contracts-responses",displayName:"Contract Native Responses Provider",baseUrl:$baseUrl,protocol:"responses"}')")"
responses_provider_id="$(jq --raw-output '.id' <<<"$responses_provider")"
responses_provider_version="$(jq --raw-output '.version' <<<"$responses_provider")"
responses_provider="$(curl --fail --silent --show-error --request PUT \
  "$api_url/api/admin/providers/$responses_provider_id/credential" --header 'content-type: application/json' \
  --header "origin: $web_origin" --cookie "$CONTRACT_SESSION_COOKIE" \
  --data "{\"expectedVersion\":$responses_provider_version,\"credential\":\"ci-mock-provider-key\"}")"
responses_model="$(curl --fail --silent --show-error --request POST \
  "$api_url/api/admin/models" --header 'content-type: application/json' \
  --header "origin: $web_origin" --cookie "$CONTRACT_SESSION_COOKIE" \
  --data "{\"providerId\":\"$responses_provider_id\",\"publicModelId\":\"contracts-responses/mock-responses\",\"upstreamModelId\":\"mock-responses\",\"displayName\":\"Contract Native Responses\",\"capabilities\":[\"chat\",\"streaming\",\"tools\",\"vision\"],\"contextWindow\":8192}")"
responses_model_id="$(jq --raw-output '.id' <<<"$responses_model")"
responses_model_version="$(jq --raw-output '.version' <<<"$responses_model")"
curl --fail --silent --show-error --request POST \
  "$api_url/api/admin/models/$responses_model_id/prices" --header 'content-type: application/json' \
  --header "origin: $web_origin" --cookie "$CONTRACT_SESSION_COOKIE" \
  --data "{\"providerModelId\":\"$responses_model_id\",\"expectedModelVersion\":$responses_model_version,\"effectiveAt\":\"2020-01-01T00:00:00.000Z\",\"inputMicrosPerMillion\":100000,\"cachedInputMicrosPerMillion\":100000,\"reasoningMicrosPerMillion\":0,\"outputMicrosPerMillion\":200000,\"fixedCallMicros\":10,\"source\":\"contract\"}" >/dev/null

echo "Explicitly unsupported contract TODOs:"
jq --raw-output '.[] | "TODO  \(.endpoint): \(.reason)"' \
  tests/contracts/unsupported-contracts.json

deno run --no-config --allow-env --allow-net \
  tests/contracts/openai-javascript.ts

venv="${CONTRACT_PYTHON_VENV:-/tmp/dg-chat-openai-contract-venv}"
python3 -m venv "$venv"
"$venv/bin/python" -m pip install --quiet --disable-pip-version-check openai==2.15.0
"$venv/bin/python" tests/contracts/openai_python.py

audio_state="$(mock_request GET /__test/state)"
jq -e '
  .audio.calls == 8 and
  .audio.sawStream == true and
  .audio.sawDiarization == true and
  .audio.lastAuthorized == true and
  .audio.lastEndpoint == "translations" and
  .audio.lastModel == "mock-transcribe" and
  .audio.lastMime == "audio/wav" and
  .audio.lastBytes == 46
' <<<"$audio_state" >/dev/null
echo "Official SDK audio multipart and idempotent replay contracts passed"
jq -e '
  (.speech.calls == 6 or (.speech.calls == 7 and .speech.aborted > 0)) and
  .speech.lastModel == "mock-transcribe" and
  .speech.sawCustomVoice == true and
  .speech.sawSse == true
' <<<"$audio_state" >/dev/null
echo "Official SDK speech binary, SSE, replay, custom voice, and cancellation contracts passed"
jq -e '
  .images.calls == 6 and
  .images.lastAuthorized == true and
  .images.lastModel == "mock-image" and
  .images.lastResponseFormat == "b64_json" and
  .images.lastCount == 1 and
  .images.lastPrompt == "Python image edit contract"
' <<<"$audio_state" >/dev/null
echo "Official SDK image generation/editing, streaming, PNG validation, and exact replay contracts passed"
jq -e '
  .scenarios["mock-responses"].opened == 18 and
  .scenarios["mock-responses"].completed == 18 and
  .scenarios["mock-responses"].lastAuthorized == true and
  .scenarios["mock-responses"].lastPath == "/v1/responses" and
  .scenarios["mock-responses"].lastHasInput == true and
  .scenarios["mock-responses"].lastHasMessages == false and
  .scenarios["mock-responses"].responsesPathViolations == 0 and
  .scenarios["mock-responses"].responsesMissingInput == 0 and
  .scenarios["mock-responses"].responsesMessagesViolations == 0 and
  .scenarios["mock-responses"].sawResponsesStoreFalse == true and
  .scenarios["mock-responses"].authorizationViolations == 0 and
  .scenarios["mock-responses"].sawResponsesTools == true and
  .scenarios["mock-responses"].sawResponsesImage == true and
  .scenarios["mock-responses"].sawResponsesToolResult == true
' <<<"$audio_state" >/dev/null
echo "Official SDK native Responses upstream translation contracts passed"

deno run --no-config --allow-env --allow-net \
  tests/contracts/upstream-stream.ts

mock_state=""
for _ in {1..50}; do
  mock_state="$(mock_request GET /__test/state)"
  if jq -e '.scenarios["mock-role-stall"].aborted > 0' <<<"$mock_state" >/dev/null; then
    break
  fi
  sleep 0.1
done
jq -e '
  .scenarios["mock-fast"].opened > 0 and
  .scenarios["mock-split"].lastAuthorized == true and
  .scenarios["mock-split"].lastAccept == "text/event-stream" and
  .scenarios["mock-split"].lastStream == true and
  .scenarios["mock-error"].lastAuthorized == true and
  .scenarios["mock-role-stall"].lastAuthorized == true and
  .scenarios["mock-role-stall"].aborted > 0
' <<<"$mock_state" >/dev/null
echo "Mock provider authentication and cancellation state contracts passed"
