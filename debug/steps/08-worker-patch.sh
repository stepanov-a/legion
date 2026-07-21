#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$SCRIPT_DIR/lib/helpers.sh"

info "Патч таймаута Zulip worker (MAX_CONSUME_SECONDS = 120)..."

FILE="/home/zulip/deployments/current/zerver/worker/outgoing_webhooks.py"

if docker exec legion-zulip-1 grep -q "MAX_CONSUME_SECONDS = 120" "$FILE" 2>/dev/null; then
  ok "Уже пропатчен"
else
  docker exec legion-zulip-1 sed -i \
    "/^class OutgoingWebhookWorker/a \ \ \ \ MAX_CONSUME_SECONDS = 120" "$FILE"
  docker exec legion-zulip-1 supervisorctl restart \
    "zulip-workers:zulip_events_outgoing_webhooks" 2>/dev/null
  ok "Worker timeout увеличен до 120 секунд"
fi
