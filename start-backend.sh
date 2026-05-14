#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/backend"
exec "$SCRIPT_DIR/.venv/bin/uvicorn" main:app --host 0.0.0.0 --port 1404
