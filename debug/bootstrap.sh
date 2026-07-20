#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── Цвета ────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[bootstrap]${NC} $1"; }
ok()    { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
fail()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# ── 1. Проверка .env ──────────────────────────────────────────
info "Проверка .env..."

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    ok ".env создан из .env.example — отредактируй при необходимости"
  else
    fail ".env.example не найден"
  fi
fi

# shellcheck disable=SC1091
set -a; source .env; set +a

# Defaults для docker-compose переменных, если их нет в .env
ZULIP_EXTERNAL_HOST="${ZULIP_EXTERNAL_HOST:-zulip.local:8443}"
ZULIP_HTTP_PORT="${ZULIP_HTTP_PORT:-8080}"
ZULIP_HTTPS_PORT="${ZULIP_HTTPS_PORT:-8443}"
MINIO_API_PORT="${MINIO_API_PORT:-9000}"
MINIO_CONSOLE_PORT="${MINIO_CONSOLE_PORT:-9001}"

# ── 2. Генерация секретов Zulip ───────────────────────────────
info "Генерация секретов Zulip (postgres, memcached, rabbitmq, redis, django)..."
bash generate_secrets.sh
ok "Секреты сгенерированы в secrets/"

# ── 3. Запуск контейнеров ─────────────────────────────────────
info "Запуск Zulip + MinIO через docker compose..."
docker compose up -d 2>&1 | sed 's/^/  /'
ok "Контейнеры запущены"

# ── 4. Ожидание готовности MinIO ──────────────────────────────
info "Ожидание MinIO..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:${MINIO_API_PORT:-9000}/minio/health/live >/dev/null 2>&1; then
    ok "MinIO готов (порт ${MINIO_API_PORT:-9000})"
    break
  fi
  sleep 2
done

# ── 5. Ожидание готовности Zulip ─────────────────────────────
info "Ожидание Zulip (может занять 2-5 минут)..."
ZULIP_READY=false
for i in $(seq 1 120); do
  ST=$(docker inspect debug-zulip-1 --format='{{.State.Health.Status}}' 2>/dev/null || echo "starting")
  if [ "$ST" = "healthy" ]; then
    ZULIP_READY=true
    ok "Zulip готов (примерно через ${i}x5s)"
    break
  fi
  sleep 5
done

if [ "$ZULIP_READY" != "true" ]; then
  warn "Zulip не стал healthy за 10 минут, проверь логи: docker logs debug-zulip-1"
  exit 0
fi

# ── 6. Проверка домена в /etc/hosts ──────────────────────────
DOMAIN="${ZULIP_EXTERNAL_HOST%%:*}"
[ -z "$DOMAIN" ] && DOMAIN="zulip.local"
if ! grep -q "$DOMAIN" /etc/hosts 2>/dev/null; then
  warn "Домен $DOMAIN не найден в /etc/hosts"
  echo -e "  ${YELLOW}Добавь строку:${NC}"
  echo -e "  ${CYAN}  127.0.0.1 $DOMAIN${NC}"
  echo -e "  ${YELLOW}Затем перезапусти скрипт${NC}"
  exit 0
else
  ok "Домен $DOMAIN есть в /etc/hosts"
fi

# ── 7. Создание realm ─────────────────────────────────────────
info "Создание организации (realm) в Zulip..."

REALM_EXISTS=$(docker exec debug-zulip-1 su zulip -c \
  "/home/zulip/deployments/current/manage.py list_realms" 2>/dev/null | grep -c "zulip\.local" || true)

if [ "$REALM_EXISTS" -eq 0 ]; then
  docker exec debug-zulip-1 su zulip -c \
    "/home/zulip/deployments/current/manage.py create_realm \
    --automated --password='$ZULIP_ADMIN_PASSWORD' \
    'Legion' '$ZULIP_ADMIN_EMAIL' 'Admin'" 2>&1 | sed 's/^/  /'
  ok "Организация Legion создана"
else
  ok "Организация уже существует"
fi

# ── 8. Получение API-ключа админа ─────────────────────────────
info "Получение API-ключа администратора..."
API_RESPONSE=$(curl -sk "https://localhost:${ZULIP_HTTPS_PORT:-8443}/api/v1/fetch_api_key" \
  -d "username=$ZULIP_ADMIN_EMAIL" -d "password=$ZULIP_ADMIN_PASSWORD" 2>&1)

NEW_API_KEY=$(echo "$API_RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('api_key',''))" 2>/dev/null || echo "")

if [ -z "$NEW_API_KEY" ]; then
  warn "Не удалось получить API-ключ: $API_RESPONSE"
  echo -e "  ${YELLOW}Получи вручную:${NC}"
  echo -e "  ${CYAN}  curl -sk https://localhost:${ZULIP_HTTPS_PORT:-8443}/api/v1/fetch_api_key \\"
  echo -e "    -d 'username=$ZULIP_ADMIN_EMAIL' -d 'password=...'${NC}"
  exit 0
fi

ok "API-ключ: $NEW_API_KEY"

# Обновляем .env
if grep -q "^ZULIP_ADMIN_API_KEY=" .env; then
  sed -i "s/^ZULIP_ADMIN_API_KEY=.*/ZULIP_ADMIN_API_KEY=$NEW_API_KEY/" .env
fi
if grep -q "^ZULIP_API_KEY=" .env; then
  sed -i "s/^ZULIP_API_KEY=.*/ZULIP_API_KEY=$NEW_API_KEY/" .env
fi
ok ".env обновлён с новым API-ключом"

# Экспортируем для дальнейших шагов
export ZULIP_API_KEY="$NEW_API_KEY"

# ── 9. Создание ботов ─────────────────────────────────────────
info "Создание ботов в Zulip..."
# Используем MCP-zulip сервер для создания ботов,
# но он ещё не зарегистрирован в opencode — делаем через curl

create_bot() {
  local SHORT_NAME="$1" FULL_NAME="$2" PAYLOAD_URL="$3"
  local RESPONSE
  RESPONSE=$(curl -sk -X POST "https://localhost:${ZULIP_HTTPS_PORT:-8443}/api/v1/bots" \
    -u "$ZULIP_ADMIN_EMAIL:$ZULIP_API_KEY" \
    -d "full_name=$FULL_NAME" \
    -d "short_name=$SHORT_NAME" \
    -d "bot_type=3" 2>&1)
  local BOT_API_KEY USER_ID
  USER_ID=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('user_id',''))" 2>/dev/null || echo "")
  BOT_API_KEY=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('api_key',''))" 2>/dev/null || echo "")
  if [ -n "$USER_ID" ]; then
    # Настраиваем webhook URL
    curl -sk -X PATCH "https://localhost:${ZULIP_HTTPS_PORT:-8443}/api/v1/bots/$USER_ID" \
      -u "$ZULIP_ADMIN_EMAIL:$ZULIP_API_KEY" \
      -d "service_interface=1" \
      -d "service_payload_url=$PAYLOAD_URL" >/dev/null 2>&1
    echo "$BOT_API_KEY"
  else
    echo ""
  fi
}

BASHKATI4_KEY=$(create_bot "bashkati4" "Башкатыч" "https://localhost:3000/webhook/zulip" 2>/dev/null)
if [ -n "$BASHKATI4_KEY" ]; then
  ok "Бот bashkati4 создан, api_key=$BASHKATI4_KEY"
else
  warn "Бот bashkati4 уже существует или не создан (пропускаем)"
fi

ADMINBOT_KEY=$(create_bot "adminbotv2" "Admin Bot" "https://localhost:3000/webhook/zulip" 2>/dev/null)
if [ -n "$ADMINBOT_KEY" ]; then
  ok "Бот adminbotv2 создан, api_key=$ADMINBOT_KEY"
else
  warn "Бот adminbotv2 уже существует или не создан (пропускаем)"
fi

# ── 10. Обновление integrations.jsonc с ключами ботов ─────────
info "Обновление .legion/integrations.jsonc..."
INTEGRATIONS_FILE="$LEGION_PROJECT_DIR/.legion/integrations.jsonc"

if [ -f "$INTEGRATIONS_FILE" ]; then
  if [ -n "$BASHKATI4_KEY" ]; then
    sed -i "s/bashkati4-bot@zulip.local\": \".*\"/bashkati4-bot@zulip.local\": \"$BASHKATI4_KEY\"/g" "$INTEGRATIONS_FILE"
  fi
  if [ -n "$ADMINBOT_KEY" ]; then
    sed -i "s/adminbotv2-bot@zulip.local\": \".*\"/adminbotv2-bot@zulip.local\": \"$ADMINBOT_KEY\"/g" "$INTEGRATIONS_FILE"
  fi
  ok "integrations.jsonc обновлён"
else
  warn "$INTEGRATIONS_FILE не найден — создай из integrations.example.jsonc"
fi

# ── Итог ──────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Бутстрап завершён успешно${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${CYAN}Zulip:${NC}     https://$DOMAIN:${ZULIP_HTTPS_PORT:-8443}"
echo -e "  ${CYAN}Admin:${NC}     $ZULIP_ADMIN_EMAIL / $ZULIP_ADMIN_PASSWORD"
echo -e "  ${CYAN}API key:${NC}   $NEW_API_KEY"
echo -e "  ${CYAN}MinIO:${NC}     http://localhost:${MINIO_API_PORT:-9000}"
echo -e "  ${CYAN}Console:${NC}   http://localhost:${MINIO_CONSOLE_PORT:-9001} (admin/admin)"
echo ""
echo -e "  ${YELLOW}Запусти Legion (сервер + прогрев MCP):${NC}"
echo -e "  ${CYAN}  export \$(grep -v '^#' $SCRIPT_DIR/.env | xargs)${NC}"
echo -e "  ${CYAN}  cd legion/packages/opencode && OPENCODE_SERVER_PASSWORD=test bun run src/index.ts serve --port 3000 &${NC}"
echo -e "  ${CYAN}  sleep 15 && curl -sk -X POST http://localhost:3000/webhook/warmup${NC}"
echo ""
