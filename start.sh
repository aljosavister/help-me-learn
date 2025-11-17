#!/usr/bin/env bash
# Start FastAPI backend and Vite frontend (after ensuring no old processes linger).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_HOST="${FRONTEND_HOST:-127.0.0.1}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

export PYTHONPATH="$ROOT_DIR:${PYTHONPATH:-}"

cleanup() {
  local code=$?
  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
  if [[ -n "${FRONTEND_PID:-}" ]]; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
  exit $code
}
trap cleanup INT TERM EXIT

monitor_processes() {
  while true; do
    local exited_pid=""
    for pid_var in BACKEND_PID FRONTEND_PID; do
      local pid="${!pid_var:-}"
      if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
        exited_pid="$pid"
        break
      fi
    done
    if [[ -n "$exited_pid" ]]; then
      wait "$exited_pid"
      break
    fi
    sleep 1
  done
}

echo "Ustavljam stare procese (če obstajajo)..."
BPORT="$BACKEND_PORT" FPORT="$FRONTEND_PORT" bash "$ROOT_DIR/stop.sh" || true

echo "Zaganjam FastAPI (uvicorn) na ${BACKEND_HOST}:${BACKEND_PORT} ..."
(
  cd "$ROOT_DIR"
  uvicorn api:app --reload --host "$BACKEND_HOST" --port "$BACKEND_PORT"
) &
BACKEND_PID=$!

echo "Zaganjam Vite frontend na ${FRONTEND_HOST}:${FRONTEND_PORT} ..."
(
  cd "$ROOT_DIR/frontend"
  VITE_API_BASE="${VITE_API_BASE:-http://${BACKEND_HOST}:${BACKEND_PORT}}" \
    npm run dev -- --host "$FRONTEND_HOST" --port "$FRONTEND_PORT"
) &
FRONTEND_PID=$!

monitor_processes
