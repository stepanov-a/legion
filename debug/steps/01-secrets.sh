#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$SCRIPT_DIR/lib/helpers.sh"

info "Генерация секретов Zulip..."
bash "$SCRIPT_DIR/generate_secrets.sh"
ok "Секреты сгенерированы"
