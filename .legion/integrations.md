# Руководство администратора: Интеграция Zulip ↔ Legion

## Архитектура

```
Пользователь → Zulip (DM боту)
  │ Outgoing webhook (POST /webhook/zulip)
  ▼
Legion Webhook Handler
  │
  │ 1. Routing (integrations.jsonc) → command name
  │ 2. Token validation (S3 per-bot config → service_tokens[])
  │ 3. Session (ключ: source:dm:sender:botEmail)
  │ 4. Если у бота есть MCP-инструменты → immediate ack в Zulip
  │ 5. LLM + MCP инструменты
  │ 6. Ответ → sendZulipReply() в Zulip API
  ▼
Ответ в Zulip от имени бота
```

**Ключевые решения:**

- **Static IP для Legion** (`172.18.0.10`) — payload URL ботов не меняется после рестарта
- **S3 — primary storage** для промптов и конфигов; локальные файлы — кэш
- **Service tokens** в S3 per-bot конфиге, не в integrations.jsonc
- **Acknowledgement** отправляется только если у бота есть MCP-инструменты
- **Session** изолирована по `botEmail + sender`, контекст не смешивается между ботами
- **Zulip worker timeout** увеличен до 120 секунд (patch outgoing_webhooks.py)

---

## 1. Быстрый старт (clean deploy)

```bash
cd /home/neo/Projects/legion_new/legion
bash debug/generate_secrets.sh
docker compose up -d
# ждём 1-3 мин пока Zulip инициализируется
```

---

## 2. Создание организации Zulip

```bash
# Создать realm
docker exec legion-zulip-1 su zulip -c '
/home/zulip/deployments/current/manage.py create_realm \
  "Legion" a.stepanov@2035.university "Admin" --string-id=legion
'

# Назначить пароль и права админа
docker exec legion-zulip-1 su zulip -c '
/home/zulip/deployments/current/manage.py shell -c "
from zerver.models import UserProfile
from django.contrib.auth.hashers import make_password
u = UserProfile.objects.get(id=8)
u.email = \"a.stepanov@2035.university\"
u.delivery_email = \"a.stepanov@2035.university\"
u.full_name = \"Admin\"
u.password = make_password(\"legion-admin-2025\")
u.is_active = True
u.is_realm_admin = True
u.save()
"'

# Получить API ключ админа
curl -sk "https://localhost:8443/api/v1/fetch_api_key" \
  -H "Host: legion.zulip.local:8443" \
  -d "username=a.stepanov@2035.university" \
  -d "password=legion-admin-2025"
# → запомнить api_key
```

---

## 3. Настройка .env

В `debug/.env` прописать (Docker DNS — для работы внутри контейнера):

```ini
# ── Zulip API (внутренний Docker DNS)
ZULIP_URL=https://zulip
ZULIP_EMAIL=a.stepanov@2035.university
ZULIP_API_KEY=<api_key_из_шага_2>
ZULIP_API_HOST=legion.zulip.local:8443

# ── Для скачивания файлов из Zulip (внешний URL)
LEGION_ZULIP_URL=https://zulip.local:8443

# ── Webhook URL для новых ботов (legion.local — статический IP)
LEGION_PAYLOAD_URL=http://legion.local:3000/webhook/zulip

# ── S3 (MinIO)
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=legion-bots

# ── Логи
OPENCODE_PRINT_LOGS=1
NODE_TLS_REJECT_UNAUTHORIZED=0
```

Перезапустить Legion: `docker compose restart legion`

---

## 4. Статический IP для Legion

В `docker-compose.yml` у сервиса `legion` указан статический IP:

```yaml
legion:
  networks:
    legion-net:
      ipv4_address: 172.18.0.10
```

Zulip имеет `extra_hosts`, указывающий на этот же IP:

```yaml
zulip:
  extra_hosts:
    - "legion.local:172.18.0.10"
```

Благодаря этому:
- `legion.local` резолвится внутри Zulip в актуальный IP
- Payload URL `http://legion.local:3000/webhook/zulip` не меняется
- Zulip URL-валидатор принимает `legion.local` (есть TLD)

---

## 5. Регистрация бота-админа

```bash
API_KEY="<api_key_из_шага_2>"

# Создать каналы
for stream in general admin bot-consulting; do
  curl -sk "https://localhost:8443/api/v1/users/me/subscriptions" \
    -H "Host: legion.zulip.local:8443" \
    -u "a.stepanov@2035.university:$API_KEY" \
    -d "subscriptions=[{\"name\":\"$stream\"}]"
done

# Создать outgoing webhook бота
RESP=$(curl -sk -X POST "https://localhost:8443/api/v1/bots" \
  -H "Host: legion.zulip.local:8443" \
  -u "a.stepanov@2035.university:$API_KEY" \
  -d "full_name=Admin Bot" \
  -d "short_name=adminbotv2" \
  -d "bot_type=3" \
  -d 'payload_url="http://legion.local:3000/webhook/zulip"')

echo "$RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user_id'], d['api_key'])"

# Получить service token (понадобится для S3 конфига)
docker exec legion-zulip-1 su zulip -c "
/home/zulip/deployments/current/manage.py shell -c '
from zerver.models.bots import Service
s = Service.objects.get(user_profile_id=<user_id>)
print(s.token)
'"
```

---

## 6. Прописать бота в конфиги

### integrations.jsonc — только routing

```jsonc
{
  "sources": [{
    "name": "zulip",
    "type": "webhook",
    "endpoint": "POST /webhook/zulip",
    "zulip_url": "https://legion.zulip.local:8443",
    "commands_dir": ".legion/command",
    "tokens": {},
    "bot_api_keys": {},
    "routing": [
      { "field": "stream", "stream": "admin",        "command": "admin" },
      { "field": "bot_email", "bot_email": "adminbotv2-bot@zulip.local", "command": "admin" },
      { "field": "stream", "stream": "*",            "command": "bashkati4" }
    ]
  }]
}
```

`tokens` и `bot_api_keys` — пустые. Валидация токенов и API-ключи — в S3 per-bot конфигах.

### admin.md

```yaml
---
name: admin
description: "Админские команды (создание ботов)"
agent: general
model: opencode-go/deepseek-v4-flash
mcp: { bot-factory: true }
allow: ["a.stepanov@2035.university"]
---
Ты — админ-бот Legion. ...
```

### bots.jsonc — реестр ботов

```jsonc
{
  "bots": [{
    "name": "admin",
    "description": "Админские команды",
    "agent": "general",
    "stream": "admin",
    "model": "opencode-go/deepseek-v4-flash",
    "mcp": { "bot-factory": true },
    "allow": ["a.stepanov@2035.university"],
    "zulip_email": "adminbotv2-bot@zulip.local",
    "zulip_api_key": "<api_key>",
    "zulip_user_id": <user_id>
  }]
}
```

---

## 7. Sync в S3 и перезагрузка

```bash
# Синхронизировать промпты и конфиги в S3
docker exec legion-legion-1 bash -c '
cat > /tmp/sync_all.ts << "EOF"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import * as fs from "fs"

const s3 = new S3Client({ region: "us-east-1", endpoint: "http://minio:9000",
  credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" }, forcePathStyle: true })
const bots = JSON.parse(fs.readFileSync("/legion/.legion/bots.jsonc", "utf-8"))
for (const bot of bots.bots) {
  await s3.send(new PutObjectCommand({
    Bucket: "legion-bots", Key: `bot-prompts/${bot.name}/config.json`,
    Body: JSON.stringify(bot, null, 2), ContentType: "application/json" }))
  const md = fs.readFileSync(`/legion/.legion/command/${bot.name}.md`, "utf-8")
  await s3.send(new PutObjectCommand({
    Bucket: "legion-bots", Key: `bot-prompts/${bot.name}/prompt.md`,
    Body: md, ContentType: "text/markdown" }))
}
EOF
bun run /tmp/sync_all.ts
'

# Перезагрузить (подтянет промпты из S3)
curl -X POST http://localhost:3000/webhook/reload
```

---

## 8. Проверка

Написать боту в DM в Zulip. Если у бота есть MCP-инструменты — сразу придёт acknowledgement, затем ответ LLM.

---

## 9. Создание новых ботов

Через админ-бота в Zulip или напрямую через bot-factory MCP:

> `создай бота <имя> для канала <stream>`

`create_bot` создаёт:
1. `.md` промпт (локально + S3: `bot-prompts/{name}/prompt.md`)
2. Zulip-бота (outgoing webhook, `bot_type=3`)
3. Routing в `integrations.jsonc`
4. Конфиг в S3: `bot-prompts/{name}/config.json`
5. Service token auto-learn при первом вебхуке

**Обновление/удаление:** `update_bot`, `delete_bot`, `get_bot` — все через bot-factory MCP.

**Self-update:** при создании с `self_update: true` — бот получает `bot-factory` MCP и может обновлять свой промпт через `update_bot`.

---

## 10. Детали реализации

### Webhook handler flow (webhook.ts)

1. **Routing** — поиск команды по `field + pattern` из `integrations.jsonc`
2. **Token validation** — проверка `payload.token` против `service_tokens[]` из S3 конфига бота. Если `service_tokens` пуст — пропускаем (auto-learn).
3. **Session** — ключ `${source}:${stream|dm}:${sender}:${botEmail}`. Каждый бот + пользователь = своя сессия.
4. **Acknowledgement** — если у бота есть MCP-инструменты (`mcp: { ... }`), сразу отправляется "✅ Принял запрос..." через Zulip API.
5. **LLM** — `sessionPrompt.prompt()` с MCP инструментами.
6. **Response** — ответ LLM отправляется через Zulip API (`sendZulipReply`) после завершения.
7. **Learn token** — `payload.token` сохраняется в S3 конфиг бота (`service_tokens[]`) для будущей валидации.
8. **Webhook return** — короткое `"✅"`, не дублирует ack.

### learnBotToken

При первом вебхуке от нового бота `service_tokens` пуст → валидация пропускается. После успешной обработки `payload.token` записывается в `bot-prompts/{name}/config.json → service_tokens[]`. Со второго запроса токен проверяется.

### sendZulipReply

Функция отправки сообщений в Zulip от имени бота. Используется для ack и для доставки ответа LLM. Использует `zulip_api_key` из S3 конфига бота + `Host: legion.zulip.local:8443`.

### Zulip worker timeout

По умолчанию `MAX_CONSUME_SECONDS = 30` — Zulip убивает обработку, если она длится дольше. Для поддержки долгих LLM-запросов патчим:

```bash
docker exec legion-zulip-1 sed -i \
  "/^class OutgoingWebhookWorker/a \ \ \ \ MAX_CONSUME_SECONDS = 120" \
  /home/zulip/deployments/current/zerver/worker/outgoing_webhooks.py
docker exec legion-zulip-1 supervisorctl restart \
  "zulip-workers:zulip_events_outgoing_webhooks"
```

---

## 11. Файловая структура

```
.legion/
├── command/              # .md промпты (локальный кэш)
├── integrations.jsonc   # Routing (в .gitignore)
├── bots.jsonc           # Реестр ботов (в .gitignore)
├── integrations.md      # Это руководство
├── mcp-bot-factory/     # MCP: управление ботами
├── mcp-zulip/           # MCP: Zulip API
└── mcp-s3-storage/      # MCP: S3 storage

S3 (legion-bots):
├── bot-prompts/{name}/prompt.md    # Промпт (primary storage)
├── bot-prompts/{name}/config.json  # Конфиг + service_tokens
└── bot-prompts/{name}/history/     # История версий промпта

debug/
├── .env                 # Конфигурация контейнера
├── generate_secrets.sh  # Генерация паролей
├── secrets/             # Пароли (в .gitignore)
└── bootstrap.sh         # Первичная настройка
```

---

## 12. Важные замечания

- **Токены не в integrations.jsonc:** `tokens: {}`. Валидация через S3 per-bot конфиг. Auto-learn при первом вебхуке.
- **S3 — primary storage:** Промпты и конфиги в S3. `/webhook/reload` подтягивает из S3 в локальный кэш.
- **Host header для Zulip API:** Все запросы к Zulip API из Docker — с заголовком `Host: legion.zulip.local:8443`.
- **Payload URL:** `http://legion.local:3000/webhook/zulip` (legion.local — статический IP 172.18.0.10).
- **Static IP в docker-compose:** `legion.networks.legion-net.ipv4_address: 172.18.0.10`.
- **Zulip worker timeout:** Патчить `MAX_CONSUME_SECONDS = 120` после каждого обновления Zulip.
- **После рестарта Zulip:** Очередь outgoing webhooks очищается. Первый DM может не дойти — отправить второй.
- **Session per bot:** Ключ сессии включает `botEmail`, контекст разных ботов не смешивается.
- **LEGION_PAYLOAD_URL:** Переменная окружения для payload URL новых ботов. По умолчанию `http://legion.local:3000/webhook/zulip`.
