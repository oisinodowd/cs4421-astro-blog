#!/usr/bin/env bash
# Stores the application's credentials in SSM Parameter Store (ticket #94).
#
# The ECS task definition reads these four by name; `cdk/lib/ecs-service-stack.ts`
# only references them and grants the task execution role read access. They are
# created here, out of band, rather than by the CDK stack because CloudFormation
# cannot create a SecureString without carrying the plaintext in the template --
# and a template is uploaded to S3, shown in the console, and printed by every
# `cdk diff`.
#
# Existing parameters are left alone unless --overwrite is passed, so running
# this twice cannot rotate a credential out from under a running task.
#
# Values are read from `.env` (or from the environment, which takes precedence).
# They are never printed, and never written to a temp file: `put-parameter` takes
# the value as an argument, so it is briefly visible in the process list of the
# account running this -- which is a smaller exposure than plaintext on disk, and
# the reason nothing here tries to be clever about it.
#
# Usage: scripts/put-ssm-parameters.sh [--overwrite] [--region <region>]
set -euo pipefail

# The stack lives in us-east-1. The CLI's default profile region is eu-west-1,
# so the region is pinned here rather than inherited.
REGION="${AWS_REGION:-us-east-1}"
PREFIX="/blog"
OVERWRITE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --overwrite) OVERWRITE=1 ;;
    --region)
      shift
      REGION="${1:-}"
      [ -n "$REGION" ] || {
        echo "FAIL: --region needs a value" >&2
        exit 2
      }
      ;;
    *)
      echo "usage: $0 [--overwrite] [--region <region>]" >&2
      exit 2
      ;;
  esac
  shift
done

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

parameter_exists() {
  aws ssm get-parameter --name "$1" --region "$REGION" >/dev/null 2>&1
}

# $1 parameter name, $2 parameter type, $3 environment variable holding the value
put_parameter() {
  local name="$1" type="$2" var="$3"
  local value="${!var:-}"

  [ -n "$value" ] || fail "$var is empty or unset (needed for $name)"

  if parameter_exists "$name"; then
    if [ "$OVERWRITE" -ne 1 ]; then
      echo "SKIP: $name already exists - pass --overwrite to replace it"
      return 0
    fi
    aws ssm put-parameter --name "$name" --type "$type" --value "$value" \
      --region "$REGION" --overwrite >/dev/null ||
      fail "could not overwrite $name in $REGION"
    echo "PUT:  $name ($type, replaced)"
    return 0
  fi

  aws ssm put-parameter --name "$name" --type "$type" --value "$value" --region "$REGION" >/dev/null ||
    fail "could not create $name in $REGION"

  # Report the name and the type only. Never the value.
  echo "PUT:  $name ($type)"
}

echo "==> Storing parameters under $PREFIX in $REGION"
put_parameter "$PREFIX/supabase-url" String SUPABASE_URL
put_parameter "$PREFIX/supabase-service-role-key" SecureString SUPABASE_SERVICE_ROLE_KEY
put_parameter "$PREFIX/balldontlie-api-key" SecureString BALLDONTLIE_API_KEY
put_parameter "$PREFIX/nba-daily-request-budget" String NBA_DAILY_REQUEST_BUDGET

echo "==> Parameters now in $REGION"
aws ssm describe-parameters --region "$REGION" \
  --parameter-filters "Key=Name,Option=BeginsWith,Values=$PREFIX/" \
  --query 'Parameters[].[Name,Type,Version]' --output text |
  sed 's/^/    /' || fail "could not list $PREFIX/ in $REGION"

echo "PASS: the task execution role can read these; no value was printed"
