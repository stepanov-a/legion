#!/usr/bin/env bash
# Синхронизация исходников: удалённая версия (VDS) — приоритет.
#
#   deploy/sync-from-vds.sh          — перенести всё, что отличается
#   deploy/sync-from-vds.sh --check  — только показать расхождения, ничего не менять
#
# Что не переносится никогда:
#   .git/, node_modules/, dist/, .git-rewrite/ — служебное;
#   secrets/, .env.stand, .legion/bots.jsonc, .legion/integrations.jsonc,
#   session-cache.json — ключи и токены, им место только на сервере;
#   .legion/logs/, monitoring/grafana-data/, *.mp4 — журналы и данные.
set -euo pipefail

HOST="${LEGION_HOST:-vdc-kvaz-chat01}"
REMOTE="${LEGION_REMOTE:-/opt/atlas-legion/}"
LOCAL="$(cd "$(dirname "$0")/.." && pwd)/"

EXCLUDES=(
  --exclude '.git/'
  --exclude '.git-rewrite/'
  --exclude node_modules
  --exclude dist
  --exclude '*.mp4'
  --exclude '*.mov'
  --exclude 'monitoring/grafana-data'
  --exclude '.legion/logs'
  --exclude 'session-cache.json'
  --exclude '.legion/bots.jsonc'
  --exclude '.legion/integrations.jsonc'
  --exclude '.env.stand'
  --exclude 'secrets/'
)

mode="sync"
[[ "${1:-}" == "--check" ]] && mode="check"

echo "источник: $HOST:$REMOTE"
echo "приёмник: $LOCAL"

if [[ "$mode" == "check" ]]; then
  changes=$(rsync -azcn --checksum --itemize-changes -e "ssh -o BatchMode=yes" "${EXCLUDES[@]}" "$HOST:$REMOTE" "$LOCAL" | grep -E '^[<>]f' || true)
else
  changes=$(rsync -az --checksum --itemize-changes -e "ssh -o BatchMode=yes" "${EXCLUDES[@]}" "$HOST:$REMOTE" "$LOCAL" | grep -E '^[<>]f' || true)
fi

if [[ -z "$changes" ]]; then
  echo "расхождений нет: локальные исходники совпадают с удалёнными"
else
  echo "$changes"
  echo "---"
  echo "файлов: $(echo "$changes" | wc -l)"
  [[ "$mode" == "check" ]] && echo "это проверка: запусти без --check, чтобы применить"
fi
