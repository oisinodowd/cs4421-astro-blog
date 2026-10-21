#!/usr/bin/env bash
# Container smoke test (ticket #32).
# Proves: image builds, container boots, /api/health is SSR (fresh
# timestamps), NODE_ENV injection is observable, Docker HEALTHCHECK healthy.
# Usage: scripts/smoke-container.sh [image-tag]
set -euo pipefail

IMAGE="${1:-blog:smoke}"
NAME="blog-smoke-$$"
ENV_NAME="blog-smoke-env-$$"
PORT=45321
ENV_PORT=45322
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
ENV_HEALTH_URL="http://127.0.0.1:${ENV_PORT}/api/health"

cleanup() {
  docker rm -f "$NAME" "$ENV_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Building image: $IMAGE"
docker build -t "$IMAGE" .

echo "==> Booting container: $NAME"
docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:4321" "$IMAGE" >/dev/null

echo "==> Waiting for Docker HEALTHCHECK to reach healthy"
healthy=0
status="unknown"
for _ in $(seq 1 45); do
  status=$(docker inspect --format '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo "missing")
  if [ "$status" = "healthy" ]; then
    healthy=1
    break
  fi
  sleep 2
done
if [ "$healthy" -ne 1 ]; then
  echo "FAIL: HEALTHCHECK never reached healthy (last status: $status)"
  docker logs "$NAME"
  exit 1
fi
echo "PASS: Docker HEALTHCHECK reached healthy"

echo "==> Checking /api/health is SSR (fresh timestamps)"
a=$(curl -sf "$HEALTH_URL") || {
  echo "FAIL: /api/health unreachable"
  exit 1
}
sleep 1
b=$(curl -sf "$HEALTH_URL") || {
  echo "FAIL: /api/health unreachable"
  exit 1
}
if [ "$a" = "$b" ]; then
  echo "FAIL: identical responses - /api/health is not SSR"
  exit 1
fi
echo "$b" | grep -q '"timestamp"' || {
  echo "FAIL: no timestamp in payload"
  exit 1
}
echo "PASS: fresh timestamps on every request"

echo "==> Checking default NODE_ENV"
echo "$b" | grep -q '"nodeEnv":"production"' || {
  echo "FAIL: expected nodeEnv=production, got: $b"
  exit 1
}
echo "PASS: nodeEnv=production by default"

echo "==> Checking NODE_ENV injection"
docker run -d --name "$ENV_NAME" -e NODE_ENV=smoke -p "127.0.0.1:${ENV_PORT}:4321" "$IMAGE" >/dev/null
ready=0
for _ in $(seq 1 30); do
  if curl -sf "$ENV_HEALTH_URL" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  echo "FAIL: env-override container never became reachable"
  docker logs "$ENV_NAME"
  exit 1
fi
env_payload=$(curl -sf "$ENV_HEALTH_URL")
echo "$env_payload" | grep -q '"nodeEnv":"smoke"' || {
  echo "FAIL: NODE_ENV injection not observable, got: $env_payload"
  exit 1
}
echo "PASS: injected NODE_ENV=smoke observable"

echo "==> Smoke test passed"
