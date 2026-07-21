#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$SCRIPT_DIR/lib/helpers.sh"

info "Проверка сети и готовности..."

# Legion IP
LEGION_IP=$(docker inspect legion-legion-1 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null)
ok "Legion IP: $LEGION_IP"

# Проверка legion.local в Zulip
HOSTS_CHECK=$(docker exec legion-zulip-1 getent hosts legion.local 2>/dev/null || echo "")
if echo "$HOSTS_CHECK" | grep -q "$LEGION_IP"; then
  ok "legion.local → $LEGION_IP (совпадает)"
else
  warn "legion.local → $HOSTS_CHECK, ожидалось $LEGION_IP"
fi

# MinIO bucket
curl -sf http://localhost:9000/minio/health/live >/dev/null 2>&1 && ok "MinIO доступен" || warn "MinIO недоступен"
