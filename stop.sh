#!/usr/bin/env bash
# Stop background FastAPI/uvicorn and Vite dev servers running on known ports.

set -euo pipefail

BACKEND_PORT="${BACKEND_PORT:-${BPORT:-8000}}"
FRONTEND_PORT="${FRONTEND_PORT:-${FPORT:-5173}}"

kill_port() {
  local port="$1"
  local pids
  if pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null); then
    echo "Ustavljam procese na portu $port (PID: $pids)"
    for pid in $pids; do
      kill "$pid" 2>/dev/null || true
    done
    sleep 1
  else
    echo "Na portu $port ni aktivnih procesov."
  fi
}

kill_port "$BACKEND_PORT"
kill_port "$FRONTEND_PORT"
