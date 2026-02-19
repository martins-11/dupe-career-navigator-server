#!/usr/bin/env bash
set -euo pipefail

# End-to-end smoke test (curl) for orchestration run-all + build status polling.
#
# Goals:
# - Demonstrate POST /orchestration/run-all
# - Poll GET /builds/:id/status until terminal state
# - Avoid requiring DB or AI credentials (uses in-memory repos + placeholder persona generation)
#
# Requirements:
# - curl
# - (recommended) jq; script can run without jq but output parsing is more limited
#
# Environment variables:
# - BASE_URL: API base (default http://localhost:3001)
# - MAX_WAIT_SECONDS: overall timeout for polling (default 60)
# - POLL_INTERVAL_SECONDS: polling interval (default 1)
#
# Notes:
# - This script creates a document, posts extracted text, runs orchestration with that documentId,
#   and then polls build status.
# - It also fetches the orchestration record for step trace and artifacts.

BASE_URL="${BASE_URL:-http://localhost:3001}"
MAX_WAIT_SECONDS="${MAX_WAIT_SECONDS:-60}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-1}"

have_jq() {
  command -v jq >/dev/null 2>&1
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

# curl wrapper with sensible defaults for smoke tests
c() {
  curl -sS -H "Content-Type: application/json" "$@"
}

json_get() {
  # json_get <json> <jq_expr>
  local json="$1"
  local expr="$2"
  if have_jq; then
    echo "$json" | jq -r "$expr"
  else
    # Best-effort fallback (not robust); jq strongly recommended.
    # We only use this to avoid hard-failing in ultra-minimal environments.
    python - <<'PY' "$json" "$expr"
import json,sys
j=json.loads(sys.argv[1])
expr=sys.argv[2]
# minimal extractor for simple paths like ".id" or ".build.id"
# does not support arrays/filters/etc.
if not expr.startswith("."):
  print("")
  sys.exit(0)
path=[p for p in expr.split(".") if p]
cur=j
try:
  for p in path:
    cur=cur[p]
  if cur is None:
    print("null")
  elif isinstance(cur,(dict,list)):
    print(json.dumps(cur))
  else:
    print(cur)
except Exception:
  print("")
PY
  fi
}

echo "== Orchestration smoke test =="
echo "BASE_URL=$BASE_URL"
echo "MAX_WAIT_SECONDS=$MAX_WAIT_SECONDS, POLL_INTERVAL_SECONDS=$POLL_INTERVAL_SECONDS"
echo

require_cmd curl
if ! have_jq; then
  echo "WARN: jq not found; using a minimal JSON parser fallback. Install jq for best results." >&2
fi

echo "-- 1) Health check"
health="$(c "$BASE_URL/health")"
echo "$health"
echo

echo "-- 2) Create a document (memory repo by default)"
# POST /documents must match DocumentCreateRequest (see src/models/documents.js)
doc_body='{
  "originalFilename": "smoke.txt",
  "mimeType": "text/plain",
  "source": "smoke-orchestration-run-all.sh",
  "storageProvider": null,
  "storagePath": null,
  "fileSizeBytes": null,
  "sha256": null
}'
doc_resp="$(c -X POST "$BASE_URL/documents" -d "$doc_body")"
echo "$doc_resp" | (have_jq && jq . || cat)
document_id="$(json_get "$doc_resp" '.id')"
if [[ -z "$document_id" || "$document_id" == "null" ]]; then
  echo "ERROR: Failed to create document or parse document id." >&2
  exit 1
fi
echo "documentId=$document_id"
echo

echo "-- 3) Attach extracted text to the document (required for extract+normalize in run-all)"
extracted_body="$(cat <<JSON
{
  "textContent": "Jane Doe\\nSenior Software Engineer\\n\\nExperience:\\n- Built Node.js + Express APIs\\n- Worked with PostgreSQL\\n- Led cross-functional delivery\\n\\nSkills: React, Node.js, Express, PostgreSQL, AWS"
}
JSON
)"
extracted_resp="$(c -X POST "$BASE_URL/documents/$document_id/extracted-text" -d "$extracted_body")"
echo "$extracted_resp" | (have_jq && jq . || cat)
echo

echo "-- 4) Run orchestration run-all (documentIds only; no uploadLink needed)"
run_all_body="$(cat <<JSON
{
  "mode": "workflow",
  "documentIds": ["$document_id"],
  "autoCreatePersona": true,
  "context": {
    "targetRole": "Backend Engineer",
    "seniority": "Senior",
    "industry": "Software"
  },
  "extract": {
    "normalize": {
      "removeExtraWhitespace": true,
      "normalizeLineBreaks": true,
      "maxLength": 20000
    }
  },
  "generate": {
    "createVersion": false
  }
}
JSON
)"
run_all_resp="$(c -X POST "$BASE_URL/orchestration/run-all" -d "$run_all_body")"
echo "$run_all_resp" | (have_jq && jq . || cat)

build_id="$(json_get "$run_all_resp" '.build.id')"
if [[ -z "$build_id" || "$build_id" == "null" ]]; then
  # Some servers might return buildId at top-level; try fallback.
  build_id="$(json_get "$run_all_resp" '.buildId')"
fi

if [[ -z "$build_id" || "$build_id" == "null" ]]; then
  echo "ERROR: Failed to parse build id from run-all response." >&2
  exit 1
fi
echo "buildId=$build_id"
echo

echo "-- 5) Poll build status until completion"
start_ts="$(date +%s)"
attempt=0
terminal=""

while true; do
  attempt=$((attempt+1))
  status_resp="$(c "$BASE_URL/builds/$build_id/status")"
  status="$(json_get "$status_resp" '.status')"
  progress="$(json_get "$status_resp" '.progress')"
  message="$(json_get "$status_resp" '.message')"

  now_ts="$(date +%s)"
  elapsed=$((now_ts - start_ts))

  echo "poll#$attempt t=${elapsed}s status=$status progress=$progress message=$(printf '%s' "$message" | tr '\n' ' ')"
  if [[ "$status" == "succeeded" || "$status" == "failed" || "$status" == "cancelled" ]]; then
    terminal="$status"
    break
  fi

  if (( elapsed >= MAX_WAIT_SECONDS )); then
    echo "ERROR: Timed out after ${MAX_WAIT_SECONDS}s polling build status." >&2
    echo "Last status payload:" >&2
    echo "$status_resp" | (have_jq && jq . || cat) >&2
    exit 1
  fi

  sleep "$POLL_INTERVAL_SECONDS"
done

echo
echo "-- 6) Fetch orchestration record (step trace + artifacts)"
orch_resp="$(c "$BASE_URL/orchestration/builds/$build_id")"
echo "$orch_resp" | (have_jq && jq . || cat)

echo
if [[ "$terminal" == "succeeded" ]]; then
  echo "SMOKE TEST PASSED: buildId=$build_id completed successfully."
  exit 0
fi

echo "SMOKE TEST FAILED: buildId=$build_id terminal status=$terminal" >&2
exit 2
