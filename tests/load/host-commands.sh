#!/usr/bin/env bash

# Runs one host-side orchestration command with a portable wall-clock bound. Docker and Compose
# clients can otherwise wait forever when the daemon, a container exec, or a health transition
# stops responding. The command is executed directly (not through eval), and its bounded diagnostic
# tail is retained in the load artifact directory.
host_command_descendants() {
  local parent_pid="$1"
  local candidate_pid
  local candidate_parent
  while read -r candidate_pid candidate_parent; do
    [[ "$candidate_parent" == "$parent_pid" ]] || continue
    host_command_descendants "$candidate_pid"
    printf '%s\n' "$candidate_pid"
  done < <(ps -axo pid=,ppid=)
}

signal_host_command_tree() {
  local signal_name="$1"
  local root_pid="$2"
  local descendants="$3"
  # Signal the root first so it cannot intentionally launch more work while the captured tree is
  # being terminated. Descendant PIDs were snapshotted before this call, so reparenting cannot hide
  # an already-running Compose CLI plugin from the remaining signals.
  kill "-$signal_name" "$root_pid" 2>/dev/null || true
  local descendant_pid
  while read -r descendant_pid; do
    [[ "$descendant_pid" =~ ^[1-9][0-9]*$ ]] || continue
    kill "-$signal_name" "$descendant_pid" 2>/dev/null || true
  done <<<"$descendants"
}

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
      local descendants
      descendants="$(host_command_descendants "$command_pid")"
      signal_host_command_tree TERM "$command_pid" "$descendants"
      local terminate_deadline=$((SECONDS + 2))
      while ((SECONDS < terminate_deadline)); do
        local survivor=false
        local process_pid
        for process_pid in "$command_pid" $descendants; do
          if kill -0 "$process_pid" 2>/dev/null; then
            survivor=true
            break
          fi
        done
        [[ "$survivor" == true ]] || break
        sleep 0.1
      done
      # A TERM-resistant child may have launched another process during the grace period. Expand
      # from every captured survivor once more before KILL, even if the original root was reaped.
      local expanded_descendants="$descendants"
      local captured_pid
      for captured_pid in "$command_pid" $descendants; do
        if kill -0 "$captured_pid" 2>/dev/null; then
          expanded_descendants="$expanded_descendants
$(host_command_descendants "$captured_pid")"
        fi
      done
      signal_host_command_tree KILL "$command_pid" "$expanded_descendants"
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
