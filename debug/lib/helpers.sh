#!/usr/bin/env bash
# Общие функции для шагов bootstrap
set -euo pipefail

export SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Цвета ────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[$(basename $0)]${NC} $1"; }
ok()    { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
fail()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# ── Zulip API ─────────────────────────────────────────────────
# Использование: zulip_api GET /path
#                zulip_api POST /path -d "data"
zulip_api() {
  local method="$1" path="$2"
  shift 2
  curl -sk "https://localhost:8443/api/v1$path" \
    -H "Host: legion.zulip.local:8443" \
    -u "$ZULIP_ADMIN_EMAIL:$ZULIP_API_KEY" \
    -X "$method" "$@"
}

# ── Django shell внутри Zulip контейнера ─────────────────────
zulip_django() {
  docker exec legion-zulip-1 su zulip -c \
    "/home/zulip/deployments/current/manage.py shell -c \"$1\"" 2>/dev/null
}

# ── Создание outgoing webhook бота ───────────────────────────
# Возвращает JSON: {"id": N, "api_key": "...", "stoken": "..."}
create_bot() {
  local short_name="$1" full_name="$2"
  local resp id key stoken

  resp=$(curl -sk -X POST "https://localhost:8443/api/v1/bots" \
    -H "Host: legion.zulip.local:8443" \
    -u "$ZULIP_ADMIN_EMAIL:$ZULIP_API_KEY" \
    -d "full_name=$full_name" \
    -d "short_name=$short_name" \
    -d "bot_type=3" \
    -d 'payload_url="http://legion.local:3000/webhook/zulip"' 2>/dev/null)

  id=$(echo "$resp" | python3 -c "import sys,json;print(json.load(sys.stdin).get('user_id',''))" 2>/dev/null)
  key=$(echo "$resp" | python3 -c "import sys,json;print(json.load(sys.stdin).get('api_key',''))" 2>/dev/null)
  stoken=$(docker exec legion-zulip-1 su zulip -c "
    /home/zulip/deployments/current/manage.py shell -c '
      from zerver.models.bots import Service
      s = Service.objects.get(user_profile_id=$id)
      print(s.token)
    '" 2>/dev/null)

  if [ -n "$id" ]; then
    echo "{\"id\":$id,\"api_key\":\"$key\",\"stoken\":\"$stoken\"}"
  else
    echo '{"id":0,"api_key":"","stoken":""}'
  fi
}

# ── LEGION_PROJECT_DIR (корень репозитория) ──────────────────
LEGION_PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
