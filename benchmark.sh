#!/usr/bin/env bash
set -euo pipefail

LIMIT=""
CONCURRENCY=""
EFFORT=""
MAX_ITERATIONS=""
OUT=""
NO_OUT=""
JSON=""
FAIL_ON_DRC=""

default_concurrency() {
  getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 4
}

CONCURRENCY="${BENCHMARK_CONCURRENCY:-$(default_concurrency)}"

print_help() {
  cat <<'EOH'
Usage:
  ./benchmark.sh [limit|all] [--concurrency N] [--effort N] [--max-iterations N] [--out PATH] [--json] [--fail-on-drc]
  ./benchmark.sh [--limit N|all] [--concurrency N] [--effort N] [--max-iterations N] [--out PATH] [--json] [--fail-on-drc]

Options:
  --limit N|all          Run first N dataset-drc14 samples, or all samples
  --concurrency N        Number of Bun workers, or "auto"
  --effort N             Solver effort value (default from TS script: 1)
  --max-iterations N     Override solver max iterations
  --out PATH             Write JSON benchmark report (default: benchmark-result.json)
  --no-out               Do not write a JSON benchmark report
  --json                 Print the JSON report to stdout
  --fail-on-drc          Exit non-zero when any final DRC remains
  -h, --help             Show this help

Defaults:
  Running ./benchmark.sh with no parameters benchmarks all dataset-drc14 samples.

Examples:
  ./benchmark.sh
  ./benchmark.sh 5
  ./benchmark.sh --limit all --concurrency auto
  ./benchmark.sh --limit all --effort 2
  ./benchmark.sh --limit 10 --max-iterations 100 --out tmp/drc14-result.json
EOH
}

if [ "${1:-}" != "" ] && [[ "${1}" != --* ]]; then
  LIMIT="$1"
  shift
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      print_help
      exit 0
      ;;
    --limit|--scenario-limit)
      LIMIT="${2:-}"
      shift 2
      ;;
    --concurrency|--concurrent|--concurent|--CONCURENT)
      CONCURRENCY="${2:-}"
      if [ "$CONCURRENCY" = "auto" ]; then
        CONCURRENCY="$(default_concurrency)"
      fi
      shift 2
      ;;
    --effort)
      EFFORT="${2:-}"
      shift 2
      ;;
    --max-iterations)
      MAX_ITERATIONS="${2:-}"
      shift 2
      ;;
    --out)
      OUT="${2:-}"
      shift 2
      ;;
    --no-out)
      NO_OUT="1"
      shift
      ;;
    --json)
      JSON="1"
      shift
      ;;
    --fail-on-drc)
      FAIL_ON_DRC="1"
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Run ./benchmark.sh --help for usage"
      exit 1
      ;;
  esac
done

CMD=(bun "scripts/benchmark-drc14.ts" "--concurrency" "$CONCURRENCY")

if [ -n "${LIMIT}" ]; then
  CMD+=("--limit" "${LIMIT}")
fi

if [ -n "${EFFORT}" ]; then
  CMD+=("--effort" "${EFFORT}")
fi

if [ -n "${MAX_ITERATIONS}" ]; then
  CMD+=("--max-iterations" "${MAX_ITERATIONS}")
fi

if [ -n "${OUT}" ]; then
  CMD+=("--out" "${OUT}")
fi

if [ -n "${NO_OUT}" ]; then
  CMD+=("--no-out")
fi

if [ -n "${JSON}" ]; then
  CMD+=("--json")
fi

if [ -n "${FAIL_ON_DRC}" ]; then
  CMD+=("--fail-on-drc")
fi

"${CMD[@]}"
