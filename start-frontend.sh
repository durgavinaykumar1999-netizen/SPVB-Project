#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/frontend"
exec npm run dev -- --host 0.0.0.0 --port 1402
