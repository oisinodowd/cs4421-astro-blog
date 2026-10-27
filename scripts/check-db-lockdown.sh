#!/usr/bin/env bash
# Database lockdown check (#93).
# Proves: with the local stack running and the migrations applied, the Data API
# roles (anon, authenticated) can neither read nor write any table, nor call the
# budget function -- while the container's service role can do both.
#
# This is the acceptance check for the migration, and the thing to re-run
# whenever a later migration adds a table.
#
# Usage: scripts/check-db-lockdown.sh   (requires: npx supabase start)
set -euo pipefail

TABLES=(teams games player_stats upstream_budget sessions session_drills)

if ! status_env=$(npx supabase status -o env 2>/dev/null); then
  echo "FAIL: could not read local Supabase status. Start it first: npx supabase start"
  exit 1
fi

get() { printf '%s\n' "$status_env" | grep -E "^${1}=" | head -1 | cut -d= -f2- | tr -d '"'; }

API_URL=$(get API_URL)
# Older CLI output calls this ANON_KEY; the current one also reports a
# publishable key. Either is the anonymous, browser-visible credential.
ANON_KEY=$(get ANON_KEY)
[ -n "$ANON_KEY" ] || ANON_KEY=$(get PUBLISHABLE_KEY)
# Likewise SERVICE_ROLE_KEY / SECRET_KEY: the credential the container holds.
SERVICE_ROLE_KEY=$(get SERVICE_ROLE_KEY)
[ -n "$SERVICE_ROLE_KEY" ] || SERVICE_ROLE_KEY=$(get SECRET_KEY)

if [ -z "$API_URL" ] || [ -z "$ANON_KEY" ] || [ -z "$SERVICE_ROLE_KEY" ]; then
  echo "FAIL: local Supabase is not running. Start it first: npx supabase start"
  exit 1
fi

REST="$API_URL/rest/v1"

# request METHOD PATH KEY [BODY] -> HTTP status code
request() {
  local method="$1" path="$2" key="$3" body="${4:-}"
  local args=(-s -o /dev/null -w '%{http_code}' -X "$method" "$REST$path"
    -H "apikey: ${key}" -H "Authorization: Bearer ${key}")
  if [ -n "$body" ]; then
    args+=(-H 'content-type: application/json' -d "$body")
  fi
  curl "${args[@]}"
}

fail=0
denied() { # description code
  # 401/403 specifically, and nothing else. Treating any non-2xx as a pass would
  # accept a 400 for a malformed body as if it were a refusal, so a granted write
  # of invalid data would look like a refusal. The API answers a denied request
  # with 401 (PostgreSQL 42501), which is the only outcome that proves denial.
  case "$2" in
    401 | 403)
      echo "PASS: $1 (http $2)"
      ;;
    *)
      echo "FAIL: $1 (http $2)"
      fail=1
      ;;
  esac
}

echo "==> The anonymous key reaches nothing"
for table in "${TABLES[@]}"; do
  denied "anon cannot read $table" "$(request GET "/${table}?select=*&limit=1" "$ANON_KEY")"
  denied "anon cannot write $table" "$(request POST "/${table}" "$ANON_KEY" '{}')"
done
denied "anon cannot call consume_upstream_budget" \
  "$(request POST '/rpc/consume_upstream_budget' "$ANON_KEY" \
    '{"p_day":"2026-01-01","p_limit":400,"p_cost":1}')"

echo "==> The container's service role still works"
for table in "${TABLES[@]}"; do
  code=$(request GET "/${table}?select=*&limit=1" "$SERVICE_ROLE_KEY")
  if [ "$code" = "200" ]; then
    echo "PASS: service role can read $table (http $code)"
  else
    echo "FAIL: service role cannot read $table (http $code)"
    fail=1
  fi
done

# A write, as the app will do it, round-tripped and cleaned up.
created=$(curl -s -X POST "$REST/sessions" \
  -H "apikey: ${SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
  -H 'content-type: application/json' -H 'prefer: return=representation' \
  -d '{"trainee":"lockdown-check","duration_min":30,"feel":"good","notes":"written by scripts/check-db-lockdown.sh"}')
id=$(printf '%s' "$created" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
if [ -z "$id" ]; then
  echo "FAIL: service role could not write a session row: $created"
  fail=1
else
  echo "PASS: service role can write a session row"
  curl -s -o /dev/null -X DELETE "$REST/sessions?id=eq.${id}" \
    -H "apikey: ${SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SERVICE_ROLE_KEY}"
fi

if [ "$fail" -ne 0 ]; then
  echo "==> Lockdown check failed"
  exit 1
fi
echo "==> Lockdown check passed"
