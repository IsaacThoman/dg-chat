#!/usr/bin/env bash

# Runs one host-side orchestration command with a portable wall-clock bound. Docker and Compose
# clients can otherwise wait forever when the daemon, a container exec, or a health transition
# stops responding. The command is executed directly (not through eval), and its bounded diagnostic
# tail is retained in the load artifact directory.
bounded_host_command() {
  local timeout_seconds="$1"
  local label="$2"
  shift 2
  if [[ ! "$timeout_seconds" =~ ^[1-9][0-9]*$ || -z "$label" || $# -eq 0 ]]; then
    echo "Invalid bounded host command invocation" >&2
    return 2
  fi
  : "${LOAD_ARTIFACT_DIR:?LOAD_ARTIFACT_DIR is required for bounded host commands}"

  local safe_label="${label//[^a-zA-Z0-9._-]/-}"
  local stdout_file
  local stderr_file
  stdout_file="$(mktemp "$LOAD_ARTIFACT_DIR/.host-${safe_label}.stdout.XXXXXX")"
  stderr_file="$(mktemp "$LOAD_ARTIFACT_DIR/.host-${safe_label}.stderr.XXXXXX")"
  local operation_log="$LOAD_ARTIFACT_DIR/host-operations.log"
  local started_at
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s start %s (timeout=%ss)\n' "$started_at" "$label" "$timeout_seconds" \
    >>"$operation_log"

  "$@" >"$stdout_file" 2>"$stderr_file" &
  local command_pid=$!
  local deadline=$((SECONDS + timeout_seconds))
  while kill -0 "$command_pid" 2>/dev/null; do
    if ((SECONDS >= deadline)); then
      kill -TERM "$command_pid" 2>/dev/null || true
      local terminate_deadline=$((SECONDS + 2))
      while kill -0 "$command_pid" 2>/dev/null && ((SECONDS < terminate_deadline)); do
        sleep 0.1
      done
      kill -KILL "$command_pid" 2>/dev/null || true
      wait "$command_pid" 2>/dev/null || true
      printf '%s timeout %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$label" \
        >>"$operation_log"
      echo "Host operation timed out after ${timeout_seconds}s: $label" >&2
      if [[ -s "$stderr_file" ]]; then
        echo "--- host stderr tail ($label) ---" >&2
        tail -n 80 "$stderr_file" >&2
      fi
      if [[ -s "$stdout_file" ]]; then
        echo "--- host stdout tail ($label) ---" >&2
        tail -n 80 "$stdout_file" >&2
      fi
      rm -f "$stdout_file" "$stderr_file"
      return 124
    fi
    sleep 0.1
  done

  local status=0
  wait "$command_pid" || status=$?
  if ((status != 0)); then
    printf '%s failed %s (status=%s)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      "$label" "$status" >>"$operation_log"
    echo "Host operation failed with status $status: $label" >&2
    if [[ -s "$stderr_file" ]]; then
      echo "--- host stderr tail ($label) ---" >&2
      tail -n 80 "$stderr_file" >&2
    fi
    if [[ -s "$stdout_file" ]]; then
      echo "--- host stdout tail ($label) ---" >&2
      tail -n 80 "$stdout_file" >&2
    fi
    rm -f "$stdout_file" "$stderr_file"
    return "$status"
  fi

  cat "$stdout_file"
  cat "$stderr_file" >&2
  printf '%s complete %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$label" \
    >>"$operation_log"
  rm -f "$stdout_file" "$stderr_file"
}
