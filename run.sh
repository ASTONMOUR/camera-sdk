#!/usr/bin/env bash
# Run the Product Capture service, its tests, or the browser self-check.
#
# The interpreter dance exists because this machine has its dependencies split
# across two installs: OpenCV/NumPy/PyYAML/Pillow live in Anaconda, while
# FastAPI/Starlette/Pydantic live in the agentic-rag virtualenv. Neither has
# everything. Rather than reinstall either, we run Anaconda's Python with the
# venv's site-packages appended to the path.
#
# On a normal machine, ignore all of that and use a single virtualenv:
#   python -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]'
# then set PC_PYTHON=python before calling this script.
#
# Usage:
#   ./run.sh serve      # start the API + capture UI on :8000
#   ./run.sh test       # Python suite
#   ./run.sh check      # browser core self-check (needs node)
#   ./run.sh all        # both test suites

set -euo pipefail
cd "$(dirname "$0")"

# --- interpreter -------------------------------------------------------------

PC_PYTHON="${PC_PYTHON:-/opt/anaconda3/bin/python3}"
EXTRA_SITE="${PC_EXTRA_SITE:-/Users/arshitprajapati/Projects/agentic-rag-assistant/.venv/lib/python3.12/site-packages}"

if [ ! -x "$PC_PYTHON" ]; then
  PC_PYTHON="$(command -v python3)"
fi

export PYTHONPATH="src${EXTRA_SITE:+:$EXTRA_SITE}${PYTHONPATH:+:$PYTHONPATH}"

# --- LabelCheck --------------------------------------------------------------
# The compliance engine lives in a separate checkout. src/productcapture/
# _labelcheck_path.py finds a sibling automatically; LABELCHECK_SRC overrides it.
if [ -n "${LABELCHECK_SRC:-}" ]; then
  export LABELCHECK_SRC
fi

# Keep captured images inside the project unless told otherwise. Not /tmp:
# macOS sandboxes it and the writes fail with EPERM.
export PRODUCTCAPTURE_SESSION_DIR="${PRODUCTCAPTURE_SESSION_DIR:-$PWD/.sessions}"

cmd="${1:-serve}"

case "$cmd" in
  serve)
    port="${PORT:-8000}"
    echo "Product Capture → http://localhost:$port"
    echo "(camera access needs localhost or HTTPS; a LAN IP over plain HTTP will be blocked by the browser)"
    exec "$PC_PYTHON" -m uvicorn productcapture.app:app --host "${HOST:-127.0.0.1}" --port "$port" --reload
    ;;
  test)
    exec "$PC_PYTHON" -m pytest tests/ "${@:2}"
    ;;
  check)
    exec node web/core/selfcheck.mjs
    ;;
  all)
    "$PC_PYTHON" -m pytest tests/ -q
    node web/core/selfcheck.mjs
    ;;
  *)
    echo "usage: $0 {serve|test|check|all}" >&2
    exit 64
    ;;
esac
