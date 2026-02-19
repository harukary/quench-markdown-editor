#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  parallel-exec.sh --jobs <jobs.tsv> [--max-parallel <N>] [--poll-sec <sec>] [--job-timeout-sec <sec>] [--log-dir <dir>]

jobs.tsv format (tab separated):
  name<TAB>cwd<TAB>prompt_file<TAB>sandbox(optional)<TAB>output_schema(optional)<TAB>output_file(optional)

Notes:
  - sandbox default: read-only
  - minimum timeout is 1800 seconds (30min)
EOF
}

JOBS_FILE=""
MAX_PARALLEL=3
POLL_SEC=10
JOB_TIMEOUT_SEC=3600
LOG_DIR="${PWD}/dev/tmp/codex-exec-logs/$(date +%Y%m%d-%H%M%S)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --jobs)
      JOBS_FILE="${2:-}"
      shift 2
      ;;
    --max-parallel)
      MAX_PARALLEL="${2:-}"
      shift 2
      ;;
    --poll-sec)
      POLL_SEC="${2:-}"
      shift 2
      ;;
    --job-timeout-sec)
      JOB_TIMEOUT_SEC="${2:-}"
      shift 2
      ;;
    --log-dir)
      LOG_DIR="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$JOBS_FILE" ]]; then
  echo "Error: --jobs is required" >&2
  usage
  exit 1
fi
if [[ ! -f "$JOBS_FILE" ]]; then
  echo "Error: jobs file not found: $JOBS_FILE" >&2
  exit 1
fi

if [[ "$JOB_TIMEOUT_SEC" -lt 1800 ]]; then
  echo "warn: --job-timeout-sec is too short ($JOB_TIMEOUT_SEC). forcing 1800s." >&2
  JOB_TIMEOUT_SEC=1800
fi

mkdir -p "$LOG_DIR"

names=()
cwds=()
prompts=()
sandboxes=()
schemas=()
outputs=()
logs=()

pids=()
states=()       # pending, running, done
started_ats=()
ended_ats=()
exit_codes=()
timed_out=()    # 0/1
term_sent=()    # 0/1

sanitize_name() {
  echo "$1" | tr ' /:' '___'
}

while IFS=$'\t' read -r name cwd prompt sandbox schema output; do
  [[ -z "${name// }" ]] && continue
  [[ "${name:0:1}" == "#" ]] && continue

  if [[ -z "${cwd:-}" || -z "${prompt:-}" ]]; then
    echo "Error: invalid row (need at least name, cwd, prompt): $name" >&2
    exit 1
  fi
  if [[ ! -d "$cwd" ]]; then
    echo "Error: cwd not found for '$name': $cwd" >&2
    exit 1
  fi
  if [[ ! -f "$prompt" ]]; then
    echo "Error: prompt file not found for '$name': $prompt" >&2
    exit 1
  fi
  if [[ -n "${schema:-}" && ! -f "$schema" ]]; then
    echo "Error: schema file not found for '$name': $schema" >&2
    exit 1
  fi

  sandbox="${sandbox:-read-only}"
  safe_name="$(sanitize_name "$name")"
  log_file="$LOG_DIR/${safe_name}.log"

  names+=("$name")
  cwds+=("$cwd")
  prompts+=("$prompt")
  sandboxes+=("$sandbox")
  schemas+=("${schema:-}")
  outputs+=("${output:-}")
  logs+=("$log_file")

  pids+=(0)
  states+=("pending")
  started_ats+=(0)
  ended_ats+=(0)
  exit_codes+=("")
  timed_out+=(0)
  term_sent+=(0)
done < "$JOBS_FILE"

TOTAL="${#names[@]}"
if [[ "$TOTAL" -eq 0 ]]; then
  echo "Error: no jobs found in $JOBS_FILE" >&2
  exit 1
fi

launch_job() {
  local i="$1"
  local name="${names[$i]}"
  local cwd="${cwds[$i]}"
  local prompt="${prompts[$i]}"
  local sandbox="${sandboxes[$i]}"
  local schema="${schemas[$i]}"
  local output="${outputs[$i]}"
  local log_file="${logs[$i]}"

  local -a cmd
  cmd=(codex exec -s "$sandbox" --skip-git-repo-check -C "$cwd")
  if [[ -n "$schema" ]]; then
    cmd+=(--output-schema "$schema")
  fi
  if [[ -n "$output" ]]; then
    cmd+=(-o "$output")
  fi
  cmd+=(-)

  (
    "${cmd[@]}" < "$prompt"
  ) >"$log_file" 2>&1 &

  pids[$i]=$!
  states[$i]="running"
  started_ats[$i]="$(date +%s)"
}

stop_all_children() {
  local i pid
  for i in "${!pids[@]}"; do
    pid="${pids[$i]}"
    if [[ "${states[$i]}" == "running" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}

trap 'echo; echo "Interrupted: stopping running jobs..."; stop_all_children; exit 130' INT TERM

next_idx=0
running=0
done_count=0

echo "jobs=$TOTAL max_parallel=$MAX_PARALLEL poll_sec=$POLL_SEC timeout_sec=$JOB_TIMEOUT_SEC"
echo "log_dir=$LOG_DIR"

while [[ "$done_count" -lt "$TOTAL" ]]; do
  while [[ "$running" -lt "$MAX_PARALLEL" && "$next_idx" -lt "$TOTAL" ]]; do
    launch_job "$next_idx"
    running=$((running + 1))
    next_idx=$((next_idx + 1))
  done

  now="$(date +%s)"
  echo
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] running=$running done=$done_count/$TOTAL"

  for i in "${!names[@]}"; do
    name="${names[$i]}"
    state="${states[$i]}"
    pid="${pids[$i]}"
    log_file="${logs[$i]}"

    if [[ "$state" == "running" ]]; then
      started="${started_ats[$i]}"
      elapsed=$((now - started))

      if kill -0 "$pid" 2>/dev/null; then
        if [[ "$elapsed" -gt "$JOB_TIMEOUT_SEC" ]]; then
          if [[ "${term_sent[$i]}" -eq 0 ]]; then
            kill "$pid" 2>/dev/null || true
            term_sent[$i]=1
            timed_out[$i]=1
          else
            kill -9 "$pid" 2>/dev/null || true
          fi
        fi
      else
        rc=0
        if wait "$pid"; then
          rc=0
        else
          rc=$?
        fi
        states[$i]="done"
        ended_ats[$i]="$(date +%s)"
        exit_codes[$i]="$rc"
        running=$((running - 1))
        done_count=$((done_count + 1))
      fi
    fi

    bytes=0
    if [[ -f "$log_file" ]]; then
      bytes=$(wc -c < "$log_file" | tr -d ' ')
    fi
    last_line=""
    if [[ -f "$log_file" ]]; then
      last_line="$(tail -n 1 "$log_file" | tr '\t' ' ' | cut -c1-80)"
    fi

    rc_show="-"
    if [[ "${states[$i]}" == "done" ]]; then
      rc_show="${exit_codes[$i]}"
    fi
    timeout_mark=""
    if [[ "${timed_out[$i]}" -eq 1 ]]; then
      timeout_mark=" timeout"
    fi

    echo "  - [$i] ${name} | state=${states[$i]}${timeout_mark} pid=$pid rc=$rc_show log_bytes=$bytes"
    if [[ -n "$last_line" ]]; then
      echo "      last: $last_line"
    fi
  done

  if [[ "$done_count" -lt "$TOTAL" ]]; then
    sleep "$POLL_SEC"
  fi
done

SUMMARY="$LOG_DIR/summary.tsv"
{
  echo -e "name\tstate\texit_code\ttimed_out\tlog_file"
  for i in "${!names[@]}"; do
    echo -e "${names[$i]}\t${states[$i]}\t${exit_codes[$i]}\t${timed_out[$i]}\t${logs[$i]}"
  done
} > "$SUMMARY"

ok=0
fail=0
for i in "${!names[@]}"; do
  if [[ "${exit_codes[$i]}" == "0" ]]; then
    ok=$((ok + 1))
  else
    fail=$((fail + 1))
  fi
done

echo
echo "completed: ok=$ok fail=$fail total=$TOTAL"
echo "summary: $SUMMARY"
exit 0
