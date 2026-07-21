#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$SCRIPT_DIR/lib/helpers.sh"

export ZULIP_API_KEY="$(cat /tmp/zulip_api_key.txt 2>/dev/null || true)"
if [ -z "$ZULIP_API_KEY" ]; then
  fail "API ключ не найден. Выполни 04-zulip-realm.sh"
fi

info "Создание потоков Zulip..."
for stream in general admin bot-consulting deep-research presentation sandbox; do
  result=$(curl -sk -X POST "https://localhost:8443/api/v1/users/me/subscriptions" \
    -H "Host: legion.zulip.local:8443" \
    -u "$ZULIP_ADMIN_EMAIL:$ZULIP_API_KEY" \
    -d "subscriptions=[{\"name\":\"$stream\"}]" 2>/dev/null)
  if echo "$result" | python3 -c "import sys,json;d=json.load(sys.stdin);sys.exit(0 if d.get('result')=='success' else 1)" 2>/dev/null; then
    ok "Поток #$stream"
  else
    warn "Поток #$stream: $(echo "$result" | python3 -c "import sys,json;print(json.load(sys.stdin).get('msg',''))" 2>/dev/null)"
  fi
done
