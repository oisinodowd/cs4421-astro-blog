#!/usr/bin/env bash
# Post-deploy smoke test (ticket #43).
# Proves the deployed environment is actually serving: a live SSR app with
# NODE_ENV=production that renders each request rather than returning cached or
# prerendered bytes. Run against the ALB URL after the ECS rollout.
# Usage: scripts/smoke-deploy.sh <base-url>
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

# The ALB can still be registering tasks when this runs, so transient failures
# are retried before they count as a failed deploy.
fetch() {
  curl -fsS --retry 10 --retry-delay 5 --retry-all-errors "$1"
}

echo "==> /api/health at $BASE_URL"
health_1=$(fetch "$BASE_URL/api/health") || fail "/api/health unreachable at $BASE_URL"
echo "$health_1" | grep -q '"status":"ok"' || fail "status is not ok: $health_1"
echo "$health_1" | grep -q '"nodeEnv":"production"' || fail "expected nodeEnv=production, got: $health_1"
time_1=$(echo "$health_1" | sed -n 's/.*"timestamp":"\([^"]*\)".*/\1/p')
[ -n "$time_1" ] || fail "no timestamp in health payload: $health_1"

sleep 1
health_2=$(fetch "$BASE_URL/api/health") || fail "/api/health unreachable on second call"
echo "$health_2" | grep -q '"status":"ok"' || fail "status is not ok on second call: $health_2"
time_2=$(echo "$health_2" | sed -n 's/.*"timestamp":"\([^"]*\)".*/\1/p')
[ -n "$time_2" ] || fail "no timestamp in second health payload: $health_2"
[ "$time_1" != "$time_2" ] ||
  fail "/api/health returned an identical timestamp ($time_1) - that is a cached response, not a live render"
echo "PASS: health ok, nodeEnv=production, timestamps move ($time_1 -> $time_2)"

echo "==> /server-time at $BASE_URL"
page_1=$(fetch "$BASE_URL/server-time") || fail "/server-time unreachable at $BASE_URL"
echo "$page_1" | grep -q 'Rendered on the server' || fail "/server-time did not render its page"
rendered_1=$(echo "$page_1" | sed -n 's/.*Request time: \([^<]*\).*/\1/p' | head -1) || true
[ -n "$rendered_1" ] || fail "no request time in /server-time"

sleep 1
page_2=$(fetch "$BASE_URL/server-time") || fail "/server-time unreachable on second call"
echo "$page_2" | grep -q 'Rendered on the server' || fail "/server-time did not render its page on second call"
rendered_2=$(echo "$page_2" | sed -n 's/.*Request time: \([^<]*\).*/\1/p' | head -1) || true
[ -n "$rendered_2" ] || fail "no request time in the second /server-time response"
[ "$rendered_1" != "$rendered_2" ] ||
  fail "/server-time returned an identical time ($rendered_1) - the page is prerendered or cached"
echo "PASS: /server-time re-renders per request ($rendered_1 -> $rendered_2)"

echo "==> Post-deploy smoke test passed"
