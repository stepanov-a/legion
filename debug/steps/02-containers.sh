#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$SCRIPT_DIR/lib/helpers.sh"

# Переходим в корень репозитория (там docker-compose.yml)
cd "$LEGION_DIR"

info "Запуск контейнеров..."

# Сначала зависимости Zulip (без RagFlow — он тяжёлый)
docker compose up -d \
  zulip-database zulip-memcached zulip-rabbitmq zulip-redis \
  minio minio-setup

info "Ожидание MinIO..."
for i in $(seq 1 30); do
  curl -sf http://localhost:9000/minio/health/live >/dev/null 2>&1 && break
  sleep 2
done
ok "MinIO готов"

# Zulip
docker compose up -d zulip
info "Ожидание Zulip (может занять 2-5 минут)..."
for i in $(seq 1 60); do
  health=$(docker inspect legion-zulip-1 --format '{{.State.Health.Status}}' 2>/dev/null || echo "starting")
  if [ "$health" = "healthy" ]; then
    ok "Zulip готов"
    break
  fi
  sleep 5
done

# Legion
docker compose up -d legion
for i in $(seq 1 12); do
  if curl -sf http://localhost:3000/webhook/reload -X POST >/dev/null 2>&1; then
    ok "Legion готов (порт 3000)"
    break
  fi
  sleep 5
done
