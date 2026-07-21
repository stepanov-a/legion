#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Legion Bootstrap — оркестратор полного развёртывания
# ──────────────────────────────────────────────────────────────
# Запуск:  bash debug/bootstrap.sh
# Пошагово: bash debug/steps/03-wait-health.sh
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/helpers.sh"

STEPS_DIR="$SCRIPT_DIR/steps"

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           Legion Bootstrap                      ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# ── Проверка .env ──────────────────────────────────────────
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  if [ -f "$SCRIPT_DIR/.env.example" ]; then
    cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
    warn ".env создан из .env.example — отредактируй при необходимости"
  else
    fail ".env.example не найден"
  fi
fi

# ── Выполнение шагов ────────────────────────────────────────
STEPS=(
  "01-secrets.sh:Генерация секретов"
  "02-containers.sh:Запуск контейнеров"
  "03-wait-health.sh:Проверка сети"
  "04-zulip-realm.sh:Создание организации Zulip"
  "05-zulip-streams.sh:Создание потоков"
  "06-zulip-bots.sh:Создание ботов"
  "07-s3-sync.sh:Синхронизация в S3"
  "08-worker-patch.sh:Патч таймаута worker"
  "09-reload.sh:Финальная перезагрузка"
)

TOTAL=${#STEPS[@]}
CURRENT=1

for entry in "${STEPS[@]}"; do
  file="${entry%%:*}"
  desc="${entry##*:}"
  echo ""
  echo -e "${CYAN}[${CURRENT}/${TOTAL}]${NC} ${desc}..."
  if bash "$STEPS_DIR/$file"; then
    ok "Шаг ${CURRENT} завершён"
  else
    fail "Шаг ${CURRENT} (${file}) упал"
  fi
  CURRENT=$((CURRENT + 1))
done

echo ""
echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Bootstrap завершён${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Напиши в Zulip боту ${CYAN}adminbotv2-bot@zulip.local${NC}"
echo -e "  или ${CYAN}consultantbot-bot@zulip.local${NC}"
echo ""
