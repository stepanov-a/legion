#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$SCRIPT_DIR/lib/helpers.sh"

if [ ! -f /tmp/zulip_api_key.txt ]; then
  fail "API ключ не найден. Выполни 04-zulip-realm.sh"
fi
export ZULIP_API_KEY="$(cat /tmp/zulip_api_key.txt)"

info "Создание потоков Zulip..."
for stream in general admin bot-consulting deep-research presentation sandbox; do
  result=$(zulip_api POST "/users/me/subscriptions" \
    -d "subscriptions=[{\"name\":\"$stream\"}]" 2>/dev/null)
  if echo "$result" | python3 -c "import sys,json;d=json.load(sys.stdin);sys.exit(0 if d.get('result')=='success' else 1)" 2>/dev/null; then
    ok "Поток #$stream"
  else
    warn "Поток #$stream: $(echo "$result" | python3 -c "import sys,json;print(json.load(sys.stdin).get('msg','?'))" 2>/dev/null)"
  fi
done
