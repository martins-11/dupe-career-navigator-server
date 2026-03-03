#!/usr/bin/env bash
set -euo pipefail

# Live HTTP checks for /builds endpoints.
#
# Usage:
#   BASE_URL=http://localhost:3001 bash scripts/live-check-builds.sh
#
# Expects:
# - /health/db returns 200 when DB is reachable
# - POST /builds returns 201 and includes persistence.type=mysql when MySQL is configured
# - GET /builds/:id returns 200
# - GET /builds/:id/status returns 200
# - POST /builds/:id/cancel returns 200

BASE_URL="${BASE_URL:-http://localhost:3001}"

echo "==> Checking DB health: ${BASE_URL}/health/db"
curl -fsS "${BASE_URL}/health/db" | tee /tmp/health_db.json >/dev/null
echo

echo "==> Creating build: POST ${BASE_URL}/builds"
curl -fsS -X POST "${BASE_URL}/builds" \
  -H 'content-type: application/json' \
  -d '{}' \
  | tee /tmp/build_create.json >/dev/null
echo

BUILD_ID="$(node -e "const d=require('/tmp/build_create.json'); console.log(d.id)")"
PERSIST_TYPE="$(node -e "const d=require('/tmp/build_create.json'); console.log(d?.persistence?.type || '')")"

echo "Build ID: ${BUILD_ID}"
echo "Persistence type: ${PERSIST_TYPE}"

if [[ -z "${BUILD_ID}" ]]; then
  echo "ERROR: build id missing from create response" >&2
  exit 1
fi

# If MySQL is configured, the endpoint should report mysql.
# (In degraded mode it may return memory, but this script is intended for the 'DB reachable' scenario.)
if [[ "${PERSIST_TYPE}" != "mysql" ]]; then
  echo "ERROR: expected persistence.type=mysql but got '${PERSIST_TYPE}'" >&2
  echo "Create response was:" >&2
  cat /tmp/build_create.json >&2
  exit 1
fi

echo "==> Fetching build: GET ${BASE_URL}/builds/${BUILD_ID}"
curl -fsS "${BASE_URL}/builds/${BUILD_ID}" | tee /tmp/build_get.json >/dev/null
echo

echo "==> Fetching status: GET ${BASE_URL}/builds/${BUILD_ID}/status"
curl -fsS "${BASE_URL}/builds/${BUILD_ID}/status" | tee /tmp/build_status.json >/dev/null
echo

echo "==> Cancelling build: POST ${BASE_URL}/builds/${BUILD_ID}/cancel"
curl -fsS -X POST "${BASE_URL}/builds/${BUILD_ID}/cancel" | tee /tmp/build_cancel.json >/dev/null
echo

echo "OK: /builds live checks passed with MySQL persistence."
