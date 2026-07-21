#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

cat > "$temporary/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$1" == "inspect" ]]; then
  shift
  if [[ "${1:-}" != "--format" ]]; then
    echo "SECRET_SENTINEL_FROM_FULL_INSPECT" >&2
    exit 91
  fi
  format="$2"
  case "$format" in
    *StopTimeout*) printf '30\n' ;;
    *State.Status*) printf 'exited\n' ;;
    *State.ExitCode*) printf '0\n' ;;
    *State.OOMKilled*) printf 'false\n' ;;
    *State.Error*) printf '\n' ;;
    *) printf 'allowlisted-state\n' ;;
  esac
  exit 0
fi

if [[ "$1" == "rm" ]]; then
  if [[ "$*" == *"dg-chat-dns-churn-"* ]]; then
    printf 'rm-holder\n' >> "$FAKE_DOCKER_LOG"
  else
    printf 'rm-app\n' >> "$FAKE_DOCKER_LOG"
  fi
  exit 0
fi

if [[ "$1" == "run" ]]; then
  printf 'run-holder\n' >> "$FAKE_DOCKER_LOG"
  if [[ "$*" == *" --ip "* ]]; then
    echo "static IP requests require a user-configured Docker subnet" >&2
    exit 95
  fi
  if [[ "${FAKE_HOLDER_RUN_FAILURE:-false}" == "true" ]]; then exit 93; fi
  printf 'holder-id\n'
  exit 0
fi

[[ "$1" == "compose" ]]
shift
while [[ "${1:-}" == "-f" ]]; do shift 2; done
command="$1"
shift
case "$command" in
  ps)
    service="${*: -1}"
    printf '%s-id\n' "$service"
    ;;
  stop)
    printf 'stop\n' >> "$FAKE_DOCKER_LOG"
    ;;
  logs)
    saw_since=false
    since=""
    service=""
    while (($#)); do
      case "$1" in
        --since)
          saw_since=true
          [[ -n "${2:-}" ]]
          since="$2"
          shift 2
          ;;
        --no-color) shift ;;
        *) service="$1"; shift ;;
      esac
    done
    printf 'since=%s\n' "$since" >> "$FAKE_DOCKER_LOG"
    if [[ "$saw_since" == "true" && "${FAKE_CURRENT_MARKERS:-false}" == "true" ]]; then
      if [[ "$service" == "app" ]]; then
        printf '{"message":"API shutdown complete"}\n'
      else
        printf '{"message":"Worker stopped"}\n'
      fi
    elif [[ "$saw_since" == "false" || "$since" == "1970-01-01T00:01:40Z" ]]; then
      # A clean historical marker exists in the second when the helper began. Failing to cross a
      # boundary before taking the cursor would incorrectly accept it as current-stop evidence.
      printf '{"message":"API shutdown complete"}\n{"message":"Worker stopped"}\n'
    fi
    ;;
  start)
    printf 'start\n' >> "$FAKE_DOCKER_LOG"
    ;;
  exec)
    if [[ "$*" == *"getent hosts app"* ]]; then
      if grep -qx 'up' "$FAKE_DOCKER_LOG" 2>/dev/null ||
        { [[ "${FAKE_SAME_ADDRESS_AFTER_START:-false}" != "true" ]] &&
          grep -qx 'start' "$FAKE_DOCKER_LOG" 2>/dev/null; }; then
        printf '10.0.0.3 app\n'
      else
        printf '10.0.0.2 app\n'
      fi
    else
      printf 'web-ready\n' >> "$FAKE_DOCKER_LOG"
      printf '{"status":"ready"}\n'
    fi
    ;;
  up)
    printf 'up\n' >> "$FAKE_DOCKER_LOG"
    count=0
    [[ ! -f "$FAKE_UP_STATE" ]] || count="$(cat "$FAKE_UP_STATE")"
    count=$((count + 1))
    printf '%s' "$count" > "$FAKE_UP_STATE"
    if [[ "${FAKE_UP_FAIL_ONCE:-false}" == "true" && "$count" == "1" ]]; then exit 94; fi
    ;;
  *) exit 92 ;;
esac
FAKE_DOCKER
chmod +x "$temporary/docker"

cat > "$temporary/date" <<'FAKE_DATE'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$*" == *%s* ]]; then
  count=0
  [[ ! -f "$FAKE_DATE_STATE" ]] || count="$(cat "$FAKE_DATE_STATE")"
  count=$((count + 1))
  printf '%s' "$count" > "$FAKE_DATE_STATE"
  if ((count <= 2)); then printf '100\n'; else printf '101\n'; fi
else
  printf '1970-01-01T00:01:41Z\n'
fi
FAKE_DATE
chmod +x "$temporary/date"

export PATH="$temporary:$PATH"
export FAKE_DOCKER_LOG="$temporary/calls.log"
export FAKE_DATE_STATE="$temporary/date-state"
export FAKE_UP_STATE="$temporary/up-state"

FAKE_CURRENT_MARKERS=true /bin/bash "$root/tests/assert-compose-graceful-restart.sh" -f fake.yml \
  > "$temporary/success.out" 2>&1
grep -qx 'stop' "$FAKE_DOCKER_LOG"
grep -qx 'start' "$FAKE_DOCKER_LOG"
grep -qx 'web-ready' "$FAKE_DOCKER_LOG"
grep -qx 'since=1970-01-01T00:01:41Z' "$FAKE_DOCKER_LOG"
if grep -q 'SECRET_SENTINEL' "$temporary/success.out"; then
  echo "graceful restart diagnostics leaked full inspect output" >&2
  exit 1
fi

: > "$FAKE_DOCKER_LOG"
rm -f "$FAKE_DATE_STATE"
set +e
FAKE_CURRENT_MARKERS=false /bin/bash "$root/tests/assert-compose-graceful-restart.sh" -f fake.yml \
  > "$temporary/stale.out" 2>&1
status=$?
set -e
if [[ "$status" == "0" ]]; then
  echo "historical shutdown markers incorrectly satisfied the current stop" >&2
  exit 1
fi
if grep -q 'SECRET_SENTINEL' "$temporary/stale.out"; then
  echo "failed graceful restart diagnostics leaked full inspect output" >&2
  exit 1
fi
if grep -qx 'start' "$FAKE_DOCKER_LOG"; then
  echo "services restarted without current-stop completion evidence" >&2
  exit 1
fi
grep -qx 'since=1970-01-01T00:01:41Z' "$FAKE_DOCKER_LOG"

for failure in holder up; do
  : > "$FAKE_DOCKER_LOG"
  rm -f "$FAKE_DATE_STATE" "$FAKE_UP_STATE"
  set +e
  if [[ "$failure" == "holder" ]]; then
    FAKE_CURRENT_MARKERS=true FAKE_SAME_ADDRESS_AFTER_START=true FAKE_HOLDER_RUN_FAILURE=true \
      /bin/bash "$root/tests/assert-compose-graceful-restart.sh" -f fake.yml \
      > "$temporary/$failure.out" 2>&1
  else
    FAKE_CURRENT_MARKERS=true FAKE_SAME_ADDRESS_AFTER_START=true FAKE_UP_FAIL_ONCE=true \
      /bin/bash "$root/tests/assert-compose-graceful-restart.sh" -f fake.yml \
      > "$temporary/$failure.out" 2>&1
  fi
  status=$?
  set -e
  if [[ "$status" == "0" ]]; then
    echo "$failure failure injection unexpectedly succeeded" >&2
    exit 1
  fi
  grep -qx 'rm-app' "$FAKE_DOCKER_LOG"
  grep -qx 'rm-holder' "$FAKE_DOCKER_LOG"
  grep -qx 'up' "$FAKE_DOCKER_LOG"
done

echo "graceful restart guard requires current-stop markers and allowlisted diagnostics"
