#!/usr/bin/env bash
# Create/refresh local Python virtual environment and install backend deps.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${ROOT_DIR}/.venv"
PYTHON_BIN="${PYTHON_BIN:-python3}"
REQUIREMENTS_FILE="${ROOT_DIR}/requirements.txt"

if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  echo "Napaka: ${PYTHON_BIN} ni nameščen ali ni v PATH." >&2
  exit 1
fi

if [[ ! -f "${REQUIREMENTS_FILE}" ]]; then
  echo "Napaka: manjkajoča datoteka requirements.txt v ${ROOT_DIR}." >&2
  exit 1
fi

if [[ -d "${VENV_DIR}" ]]; then
  echo "Virtualno okolje že obstaja pri ${VENV_DIR}."
else
  echo "Ustvarjam virtualno okolje v ${VENV_DIR} ..."
  "${PYTHON_BIN}" -m venv "${VENV_DIR}"
fi

PIP_BIN="${VENV_DIR}/bin/pip"
PY_BIN="${VENV_DIR}/bin/python"

if [[ ! -x "${PIP_BIN}" ]]; then
  echo "Napaka: pip ni bil najden v ${PIP_BIN}. Preveri ustvarjanje venv." >&2
  exit 1
fi

echo "Posodabljam pip ..."
"${PY_BIN}" -m pip install --upgrade pip

echo "Nameščam Python odvisnosti iz ${REQUIREMENTS_FILE} ..."
"${PIP_BIN}" install -r "${REQUIREMENTS_FILE}"

cat <<'EOF'

✅ Namestitev zaključena.

Aktiviraj okolje z:
    source .venv/bin/activate

Za ročni zagon API:
    uvicorn api:app --reload --host 0.0.0.0 --port 8000

EOF
