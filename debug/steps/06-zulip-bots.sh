#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$SCRIPT_DIR/lib/helpers.sh"

export ZULIP_API_KEY="$(cat /tmp/zulip_api_key.txt 2>/dev/null || true)"
if [ -z "$ZULIP_API_KEY" ]; then
  fail "API ключ не найден. Выполни 04-zulip-realm.sh"
fi

info "Создание outgoing-webhook ботов..."

# adminbotv2
ADMIN=$(create_bot "adminbotv2" "Admin Bot")
ADMIN_ID=$(echo "$ADMIN" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['id'])")
ADMIN_KEY=$(echo "$ADMIN" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['api_key'])")
ADMIN_STOKEN=$(echo "$ADMIN" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['stoken'])")

if [ "$ADMIN_ID" = "0" ]; then
  fail "adminbotv2 не создан"
fi
ok "adminbotv2 id=$ADMIN_ID key=$ADMIN_KEY stoken=$ADMIN_STOKEN"

# consultantbot
CONS=$(create_bot "consultantbot" "Bot Consultant")
CONS_ID=$(echo "$CONS" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['id'])")
CONS_KEY=$(echo "$CONS" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['api_key'])")
CONS_STOKEN=$(echo "$CONS" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['stoken'])")

if [ "$CONS_ID" = "0" ]; then
  fail "consultantbot не создан"
fi
ok "consultantbot id=$CONS_ID key=$CONS_KEY stoken=$CONS_STOKEN"

# Сохраняем для следующих шагов
cat > /tmp/bots_data.json << JSONEOF
{
  "admin": {"id": $ADMIN_ID, "api_key": "$ADMIN_KEY", "stoken": "$ADMIN_STOKEN"},
  "consultantbot": {"id": $CONS_ID, "api_key": "$CONS_KEY", "stoken": "$CONS_STOKEN"}
}
JSONEOF
