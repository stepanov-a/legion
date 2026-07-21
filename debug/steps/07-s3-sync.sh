#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$SCRIPT_DIR/lib/helpers.sh"

if [ ! -f /tmp/bots_data.json ]; then
  fail "Данные ботов не найдены. Выполни 06-zulip-bots.sh"
fi

info "Синхронизация конфигов и промптов в S3..."

BOTS_DATA=$(cat /tmp/bots_data.json)
ADMIN_ID=$(echo "$BOTS_DATA" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['admin']['id'])")
ADMIN_KEY=$(echo "$BOTS_DATA" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['admin']['api_key'])")
ADMIN_STOKEN=$(echo "$BOTS_DATA" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['admin']['stoken'])")
CONS_ID=$(echo "$BOTS_DATA" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['consultantbot']['id'])")
CONS_KEY=$(echo "$BOTS_DATA" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['consultantbot']['api_key'])")
CONS_STOKEN=$(echo "$BOTS_DATA" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['consultantbot']['stoken'])")

# Запись bots.jsonc
cat > "$LEGION_DIR/.legion/bots.jsonc" << BOTSEOF
{
  "bots": [
    {
      "name": "admin",
      "description": "Админские команды (создание ботов)",
      "agent": "general",
      "stream": "admin",
      "model": "opencode-go/deepseek-v4-flash",
      "mcp": { "bot-factory": true },
      "allow": ["a.stepanov@2035.university"],
      "zulip_email": "adminbotv2-bot@zulip.local",
      "zulip_api_key": "$ADMIN_KEY",
      "zulip_user_id": $ADMIN_ID
    },
    {
      "name": "bot-consultant",
      "description": "Консультант по созданию ботов Legion",
      "agent": "general",
      "stream": "bot-consulting",
      "model": "opencode-go/deepseek-v4-flash",
      "mcp": { "bot-factory": true, "zulip": true },
      "zulip_email": "consultantbot-bot@zulip.local",
      "zulip_api_key": "$CONS_KEY",
      "zulip_user_id": $CONS_ID
    }
  ]
}
BOTSEOF

# Sync в S3 через bun внутри контейнера
docker exec legion-legion-1 bash -c "
cat > /tmp/bootstrap_sync.ts << 'SYNCEOF'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import * as fs from 'fs'

const s3 = new S3Client({ region: 'us-east-1', endpoint: 'http://minio:9000',
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' }, forcePathStyle: true })

const BOTS = JSON.parse(fs.readFileSync('/legion/.legion/bots.jsonc', 'utf-8')).bots
const TOKENS: Record<string, string> = {
  admin: '$ADMIN_STOKEN',
  'bot-consultant': '$CONS_STOKEN',
}

for (const bot of BOTS) {
  const cfg = { ...bot, service_tokens: TOKENS[bot.name] ? [TOKENS[bot.name]] : [] }
  await s3.send(new PutObjectCommand({
    Bucket: 'legion-bots', Key: 'bot-prompts/' + bot.name + '/config.json',
    Body: JSON.stringify(cfg, null, 2), ContentType: 'application/json',
  }))
  console.log('cfg:', bot.name)

  try {
    const md = fs.readFileSync('/legion/.legion/command/' + bot.name + '.md', 'utf-8')
    await s3.send(new PutObjectCommand({
      Bucket: 'legion-bots', Key: 'bot-prompts/' + bot.name + '/prompt.md', Body: md, ContentType: 'text/markdown',
    }))
    console.log('md: ', bot.name)
  } catch(e) { console.log('no md for', bot.name) }
}
SYNCEOF
bun run /tmp/bootstrap_sync.ts 2>/dev/null
"

ok "bots.jsonc + configs + prompts синхронизированы в S3"
