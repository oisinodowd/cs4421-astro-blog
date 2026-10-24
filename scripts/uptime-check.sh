#!/usr/bin/env bash
# Uptime probe (ticket #44).
# Calls the live ECS health endpoint and exits 0 only when it answers HTTP 200
# with status "ok". The scheduled workflow turns a non-zero exit into an
# incident issue, so the output is kept readable for the issue body.
# Usage: scripts/uptime-check.sh <base-url>
set -euo pipefail

BASE_URL="${1:-}"
if [ -z "$BASE_URL" ]; then
  echo "usage: $0 <base-url>" >&2
  exit 2
fi
case "$BASE_URL" in
  http://* | https://*) ;;
  *)
    echo "FAIL: base URL must start with http:// or https:// (got: $BASE_URL)" >&2
    exit 2
    ;;
esac
BASE_URL="${BASE_URL%/}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

body_file=$(mktemp)
trap 'rm -f "$body_file"' EXIT

# Three attempts absorb a transient blip or a task replacement without paging
# for it; the next scheduled probe is only 15 minutes away either way.
http_code=$(curl -sS --max-time 10 --retry 3 --retry-delay 5 --retry-all-errors \
  -o "$body_file" -w '%{http_code}' "$BASE_URL/api/health") ||
  fail "/api/health unreachable at $BASE_URL"

body=$(cat "$body_file")

[ "$http_code" = "200" ] || fail "/api/health returned HTTP $http_code: $body"
echo "$body" | grep -q '"status":"ok"' || fail "/api/health did not report status ok: $body"

echo "PASS: /api/health returned 200 with status ok at $BASE_URL"
