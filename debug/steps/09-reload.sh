#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$SCRIPT_DIR/lib/helpers.sh"

info "Финальная перезагрузка Legion..."

sleep 3
RESULT=$(curl -sf http://localhost:3000/webhook/reload -X POST 2>/dev/null || echo "")

if echo "$RESULT" | grep -q "Cache reloaded"; then
  ok "Legion перезагружен: $RESULT"
else
  warn "Legion ответил: $RESULT"
fi

# Проверка: отправляем тестовый вебхук
TEST=$(curl -sf http://localhost:3000/webhook/zulip -X POST \
  -H "Content-Type: application/json" \
  -d '{"bot_email":"adminbotv2-bot@zulip.local","token":"","message":{"sender_email":"a.stepanov@2035.university","sender_full_name":"Admin","content":"тест","type":"private","display_recipient":"dm"}}' 2>/dev/null || echo "")

if echo "$TEST" | grep -q "content"; then
  ok "Вебхук-хендлер отвечает"
else
  warn "Вебхук-хендлер не отвечает: $TEST"
fi
