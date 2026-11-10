#!/usr/bin/env bash
# Cron wrapper for a Consilium audit.
#
# Runs:
#   consilium audit --since origin/main --fail-on high --deadline 900000
#
# from the repository root, appends stdout/stderr to a timestamped log, and
# exits with the CLI status (0 pass, 1 run failed, 2 usage/setup error, 3 gate
# failed). Cron has a minimal environment, so set CONSILIUM_BIN to an absolute
# path when the CLI is not on PATH.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${CONSILIUM_REPO_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
LOG_DIR="${CONSILIUM_LOG_DIR:-$REPO_DIR/.consilium/logs}"
SINCE="${CONSILIUM_SINCE:-origin/main}"
FAIL_ON="${CONSILIUM_FAIL_ON:-high}"
DEADLINE_MS="${CONSILIUM_DEADLINE_MS:-900000}"
MAX_COST="${CONSILIUM_MAX_COST:-2.00}"
REPORT="${CONSILIUM_REPORT:-$REPO_DIR/consilium-audit.md}"

mkdir -p "$LOG_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$LOG_DIR/consilium-audit-$STAMP.log"
: >"$LOG"

cd "$REPO_DIR"

# Keep one audit at a time on systems that provide flock (Linux). macOS cron
# users can rely on the schedule instead, or use launchd.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOG_DIR/.audit.lock"
  if ! flock -n 9; then
    echo "Another Consilium audit is running; skipping this run." | tee -a "$LOG" >&2
    exit 0
  fi
fi

if [[ -n "${CONSILIUM_BIN:-}" ]]; then
  CLI=("$CONSILIUM_BIN")
elif command -v consilium >/dev/null 2>&1; then
  CLI=(consilium)
else
  CLI=(npx -y lv24-opencode-consilium@1.12.1)
fi

set +e
git fetch --prune --quiet origin >>"$LOG" 2>&1
fetch_status=$?
set -e
if (( fetch_status != 0 )); then
  echo "git fetch failed with exit code $fetch_status" | tee -a "$LOG" >&2
  exit "$fetch_status"
fi

ARGS=(audit --since "$SINCE" --fail-on "$FAIL_ON" --deadline "$DEADLINE_MS"
  --report pr --report-file "$REPORT")
if [[ -n "$MAX_COST" ]]; then
  ARGS+=(--max-cost "$MAX_COST")
fi

echo "Running: ${CLI[*]} ${ARGS[*]}" >>"$LOG"
set +e
"${CLI[@]}" "${ARGS[@]}" 2>&1 | tee -a "$LOG"
status=${PIPESTATUS[0]}
set -e

echo "exit=$status report=$REPORT log=$LOG" >>"$LOG"
exit "$status"
