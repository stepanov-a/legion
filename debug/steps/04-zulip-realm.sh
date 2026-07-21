#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$SCRIPT_DIR/lib/helpers.sh"

info "Создание организации и админа в Zulip..."

# Создать realm (если уже есть — игнорируем ошибку)
docker exec legion-zulip-1 su zulip -c '
  /home/zulip/deployments/current/manage.py create_realm \
    "Legion" a.stepanov@2035.university "Admin" --string-id=legion
' 2>/dev/null && ok "Realm создан" || warn "Realm уже существует"

# Настроить админа (переменные экранированы для docker exec)
docker exec legion-zulip-1 su zulip -c "
  /home/zulip/deployments/current/manage.py shell -c '
from zerver.models import UserProfile
from django.contrib.auth.hashers import make_password
try:
    u = UserProfile.objects.get(id=8)
    u.email = \"$ZULIP_ADMIN_EMAIL\"
    u.delivery_email = \"$ZULIP_ADMIN_EMAIL\"
    u.full_name = \"Admin\"
    u.password = make_password(\"$ZULIP_ADMIN_PASSWORD\")
    u.is_active = True
    u.is_realm_admin = True
    u.save()
    print(\"ok\")
except Exception as e:
    print(f\"skip: {e}\")
' 2>/dev/null


# Получить API ключ
API_KEY=$(curl -sk "https://localhost:8443/api/v1/fetch_api_key" \
  -H "Host: legion.zulip.local:8443" \
  -d "username=$ZULIP_ADMIN_EMAIL" \
  -d "password=$ZULIP_ADMIN_PASSWORD" 2>/dev/null | python3 -c "
import sys,json
print(json.load(sys.stdin).get('api_key',''))
")

if [ -z "$API_KEY" ]; then
  fail "Не удалось получить API ключ"
fi

ok "API ключ: $API_KEY"

# Обновить .env
for f in "$SCRIPT_DIR/.env" "$LEGION_DIR/.env"; do
  if [ -f "$f" ]; then
    sed -i "s/^ZULIP_API_KEY=.*/ZULIP_API_KEY=$API_KEY/" "$f" 2>/dev/null || true
  fi
done

# Экспорт для следующих шагов
echo "$API_KEY" > /tmp/zulip_api_key.txt
export ZULIP_API_KEY="$API_KEY"
