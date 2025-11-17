#!/usr/bin/env bash
# Kompleten build (backend deps + frontend dist) in opcijski restart servisov.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_BASE="${VITE_API_BASE:-http://127.0.0.1:8000}"
RESTART_SERVICES="${RESTART_SERVICES:-false}"

cd "${ROOT_DIR}"

echo "=== 1) Posodabljam virtualno okolje ==="
./setup_venv.sh

echo "=== 2) Gradim frontend (VITE_API_BASE=${API_BASE}) ==="
cd "${ROOT_DIR}/frontend"
npm install
VITE_API_BASE="${API_BASE}" npm run build
cd "${ROOT_DIR}"

if [[ "${RESTART_SERVICES}" == "true" ]]; then
  if command -v systemctl >/dev/null 2>&1; then
    echo "=== 3) Restartiram systemd servisa ==="
    sudo systemctl restart german-backend.service || true
    sudo systemctl restart german-frontend.service || true
  else
    echo "systemctl ni na voljo; preskakujem restart."
  fi
else
  cat <<EOF

Servisa german-backend.service / german-frontend.service nista bila restartana.
Če želiš samodejni restart, zaženi:
    RESTART_SERVICES=true VITE_API_BASE=${API_BASE} ./build_all.sh
ali pa ročno:
    sudo systemctl restart german-backend.service
    sudo systemctl restart german-frontend.service
EOF
fi

echo "✅ Build zaključen."
