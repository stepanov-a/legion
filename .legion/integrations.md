# Руководство администратора: Интеграция Zulip ↔ Legion

## Архитектура

```
Пользователь → Zulip (DM или @упоминание в канале)
  │ Outgoing webhook (POST /webhook/zulip)
  ▼
Legion Webhook Handler
  │
  │ 1. Routing (integrations.jsonc) → command name
  │ 2. Token validation (S3 per-bot config → service_tokens[])
  │ 3. Session (ключ: source:dm:stream:topic:sender:botEmail:command)
  │ 4. Stream context (fetch last 10 msgs from channel+topic)
  │ 5. Если у бота есть MCP-инструменты → immediate ack
  │ 6. LLM + MCP инструменты
  │ 7. Ответ → sendZulipReply() (в канал или DM)
  ▼
Ответ в Zulip от имени бота
```

**Ключевые решения:**

| Решение | Зачем |
|---------|-------|
| **Static IP** (172.18.0.10) | Payload URL ботов не меняется после рестарта |
| **S3 — primary storage** | Промпты и конфиги в S3, локальные файлы — кэш |
| **Service tokens в S3** | Не в integrations.jsonc, auto-learn при первом вебхуке |
| **Session key = source:dm:sender:botEmail:command** | Разные боты/команды — разные сессии |
| **Stream context** | Бот видит последние 10 сообщений из топика |
| **Ack при MCP** | Пользователь получает мгновенный отклик |
| **sendZulipReply** | Ответ через Zulip API, не зависит от HTTP-ответа вебхука |
| **Chunking >9K символов** | Длинные ответы LLM нарезаются на части |
| **DEFAULT_MODEL** | Модель для новых ботов из env |

---

## 1. Быстрый старт (clean deploy)

```bash
cd /home/neo/Projects/legion_new/legion
bash debug/bootstrap.sh
```

После завершения написать в DM админ-боту: `список ботов`.

---

## 2. Пошаговое развёртывание (без bootstrap)

### 2.1 Секреты и контейнеры

```bash
bash debug/generate_secrets.sh
docker compose up -d
# ждём 1-5 мин: Zulip инициализация
```

### 2.2 Создание организации Zulip

```bash
docker exec legion-zulip-1 su zulip -c '
  /home/zulip/deployments/current/manage.py create_realm \
    "Legion" a.stepanov@2035.university "Admin" --string-id=legion
'

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

API_KEY=$(curl -sk "https://localhost:8443/api/v1/fetch_api_key" \
  -H "Host: legion.zulip.local:8443" \
  -d "username=a.stepanov@2035.university" \
  -d "password=legion-admin-2025" | python3 -c "import sys,json;print(json.load(sys.stdin).get('api_key',''))")
```

### 2.3 Настройка .env

В `debug/.env` и `.env`:

```ini
# ── Администратор Zulip ──────────────────────────────────────────
ZULIP_ADMIN_EMAIL=a.stepanov@2035.university
ZULIP_ADMIN_PASSWORD=legion-admin-2025

# ── Доступ к Zulip API (из контейнера Legion) ────────────────────
ZULIP_URL=https://zulip                     # Docker DNS, порт 443
ZULIP_EMAIL=a.stepanov@2035.university
ZULIP_API_KEY=<api_key_из_шага_2.2>        # Заполняется bootstrap.sh
ZULIP_API_HOST=legion.zulip.local:8443     # Host header для subdomain

# ── Для вебхука (Legion → Zulip при скачивании файлов) ──────────
LEGION_ZULIP_URL=https://zulip.local:8443

# ── URL для вебхуков создаваемых ботов ────────────────────────────
LEGION_PAYLOAD_URL=http://legion.local:3000/webhook/zulip

# ── Модель по умолчанию для новых ботов ───────────────────────────
DEFAULT_MODEL=opencode-go/deepseek-v4-flash

# ── S3 (MinIO) ────────────────────────────────────────────────────
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=legion-bots

# ── Логи ─────────────────────────────────────────────────────────
OPENCODE_PRINT_LOGS=1
NODE_TLS_REJECT_UNAUTHORIZED=0
```

### 2.4 Создание потоков и ботов

```bash
API_KEY="<из_шага_2.2>"

# Потоки
for stream in general admin bot-consulting; do
  curl -sk "https://localhost:8443/api/v1/users/me/subscriptions" \
    -H "Host: legion.zulip.local:8443" \
    -u "a.stepanov@2035.university:$API_KEY" \
    -d "subscriptions=[{\"name\":\"$stream\"}]"
done

# adminbotv2
curl -sk -X POST "https://localhost:8443/api/v1/bots" \
  -H "Host: legion.zulip.local:8443" \
  -u "a.stepanov@2035.university:$API_KEY" \
  -d "full_name=adminbotv2&short_name=adminbotv2&bot_type=3" \
  -d 'payload_url="http://legion.local:3000/webhook/zulip"'

# consultantbot
curl -sk -X POST "https://localhost:8443/api/v1/bots" \
  -H "Host: legion.zulip.local:8443" \
  -u "a.stepanov@2035.university:$API_KEY" \
  -d "full_name=consultantbot&short_name=consultantbot&bot_type=3" \
  -d 'payload_url="http://legion.local:3000/webhook/zulip"'
```

### 2.5 Получение service token'ов

```bash
docker exec legion-zulip-1 su zulip -c "
  /home/zulip/deployments/current/manage.py shell -c '
from zerver.models.bots import Service
for u_id in [9, 10]:
    s = Service.objects.get(user_profile_id=u_id)
    print(f\"user {u_id}: {s.token}\")
"' 2>/dev/null
```

### 2.6 Запись конфигов и синхронизация в S3

После получения service token'ов записать их в `.legion/bots.jsonc` (см. пример), затем:

```bash
# Sync в S3
docker exec legion-legion-1 bash -c '
cat > /tmp/sync.ts << "SYNCEOF"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import * as fs from "fs"
const s3 = new S3Client({ region: "us-east-1", endpoint: "http://minio:9000",
  credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" }, forcePathStyle: true })
const bots = JSON.parse(fs.readFileSync("/legion/.legion/bots.jsonc", "utf-8")).bots
for (const bot of bots) {
  await s3.send(new PutObjectCommand({ Bucket: "legion-bots",
    Key: "bot-prompts/"+bot.name+"/config.json", Body: JSON.stringify(bot, null, 2) }))
  try {
    const md = fs.readFileSync("/legion/.legion/command/"+bot.name+".md", "utf-8")
    await s3.send(new PutObjectCommand({ Bucket: "legion-bots",
      Key: "bot-prompts/"+bot.name+"/prompt.md", Body: md }))
  } catch {}
}
SYNCEOF
bun run /tmp/sync.ts
'

# Патч таймаута
docker exec legion-zulip-1 sed -i \
  "/^class OutgoingWebhookWorker/a \ \ \ \ MAX_CONSUME_SECONDS = 120" \
  /home/zulip/deployments/current/zerver/worker/outgoing_webhooks.py
docker exec legion-zulip-1 supervisorctl restart "zulip-workers:zulip_events_outgoing_webhooks"

# Перезагрузка
curl -X POST http://localhost:3000/webhook/reload
```

---

## 3. Модель данных

### integrations.jsonc — routing

```jsonc
{
  "sources": [{
    "name": "zulip",
    "endpoint": "POST /webhook/zulip",
    "zulip_url": "https://legion.zulip.local:8443",
    "tokens": {},        // пусто — в S3 per-bot конфигах
    "bot_api_keys": {},  // пусто — в S3 per-bot конфигах
    "routing": [
      // Правила проверяются по порядку, первое совпадение
      { "stream": "admin",  "command": "admin" },
      { "field": "bot_email", "bot_email": "adminbotv2-bot@zulip.local", "command": "admin" },
      { "field": "bot_email", "bot_email": "consultantbot-bot@zulip.local", "command": "bot-consultant" },
      { "stream": "*", "command": "bashkati4" }  // catch-all
    ]
  }]
}
```

Правило может проверять:
- `stream` — имя канала (для сообщений из канала)
- `bot_email` — email бота (для DM к боту)
- `sender_email` — email отправителя
- `chat_id` — ID чата

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
    "zulip_user_id": 9,
    "service_tokens": ["<service_token>"]
  }]
}
```

### S3 структура

```
legion-bots/
├── bot-prompts/{name}/
│   ├── prompt.md           # Промпт бота (primary storage)
│   ├── config.json         # Конфиг + service_tokens + api_key
│   └── history/            # История версий промпта (бэкапы при update_bot)
```

**`config.json` в S3:**
```json
{
  "name": "veronika",
  "agent": "general",
  "model": "opencode-go/deepseek-v4-flash",
  "mcp": { "zulip": true },
  "zulip_email": "veronika-bot@zulip.local",
  "zulip_api_key": "<api_key>",
  "service_tokens": ["<service_token>"]
}
```

`service_tokens` — пустой при создании, заполняется при первом вебхуке (`learnBotToken`).

---

## 4. Bot-factory MCP (управление ботами)

### Инструменты

| Инструмент | Описание |
|------------|----------|
| `create_bot` | Создать бота: `.md` + Zulip-бот + routing + S3 |
| `list_bots` | Список ботов из `bots.jsonc` |
| `get_bot` | Информация о боте (frontmatter, stream, model, mcp) |
| `update_bot` | Обновить промпт/model/mcp/allow бота |
| `delete_bot` | Удалить бота (деактивация + очистка) |
| `reset_session` | Сбросить все LLM-сессии |

### create_bot параметры

| Параметр | Обязательный | Описание |
|----------|-------------|----------|
| `name` | да | Имя команды (латиница, без пробелов) |
| `description` | да | Описание для frontmatter |
| `prompt` | да | Полный текст промпта |
| `stream` | нет | Канал Zulip (по умолчанию `*`) |
| `model` | нет | Модель (по умолчанию из `DEFAULT_MODEL`) |
| `mcp` | нет | MCP-инструменты через запятую |
| `agent` | нет | Агент opencode (по умолчанию `general`) |
| `allow` | нет | Whitelist email'ов через запятую |
| `self_update` | нет | Добавить `bot-factory` в mcp + инструкцию о self-update |

### update_bot параметры

Все параметры опциональны. Указывать только то, что нужно изменить.

| Параметр | Описание |
|----------|----------|
| `name` | Имя команды (обязательный) |
| `prompt` | Новый текст промпта |
| `model` | Новая модель |
| `description` | Новое описание |
| `stream` | Новый канал |
| `mcp` | Новый список MCP-инструментов |
| `allow` | Новый allow (пустая строка — снять ограничение) |
| `agent` | Новый агент |
| `sender_email` | Email отправителя для проверки allow |

---

## 5. Детали реализации

### Webhook handler flow (`webhook.ts`)

```
1. Route → поиск команды по field + pattern из integrations.jsonc
2. Token validation → payload.token против service_tokens[] из S3
3. Stream context → fetch последних 10 сообщений из того же канала+топика
4. Command loading → чтение .md файла (frontmatter + тело промпта)
5. Allow check → если allow указан, проверка sender_email
6. File download → скачивание прикреплённых файлов из Zulip
7. S3 upload → сохранение файлов в S3 (forkDetach)
8. RAGFlow upload → индексация текста (forkDetach, если указан ragflow_dataset)
9. Prompt rendering → замена переменных + вставка контекста + файлов
10. Model resolution → поиск модели в провайдере
11. Ack → если есть MCP-инструменты → отправка «✅ Принял запрос.»
12. LLM → sessionPrompt.prompt() с MCP инструментами
13. Response → ответ LLM через sendZulipReply в тот же канал/DM
14. Token learn → сохранение payload.token в service_tokens
```

### Session key

```ts
// DM:  zulip:dm:Admin:adminbotv2-bot@zulip.local:admin
// DM:  zulip:dm:Admin:consultantbot-bot@zulip.local:bot-consultant
// Stream: zulip:general:ананас:admin
```

Ключ включает `botEmail` и `commandName` — разные команды получают разные сессии.

### Ack

Если у бота есть MCP-инструменты в frontmatter, перед LLM отправляется:

> ✅ Принял запрос.

Сообщение отправляется через `sendZulipReply` в тот же канал/DM, где был задан вопрос.

### Ответ в канал vs DM

- Если сообщение было в канале → ответ в тот же канал, в ту же тему
- Если DM → ответ в DM

### Chunking

Ответы LLM длиннее 9000 символов нарезаются на части. split по границе абзаца (`\n\n`), предложения (`. `), или пробела. К каждой части добавляется `(N/M)`.

### Stream context

Перед отправкой промпта LLM, из канала загружаются последние 10 сообщений в той же теме. Они добавляются в промпт под заголовком `### История сообщений в теме`. Только для stream-сообщений с непустым топиком.

### Session reset

- Через bot-factory MCP: `reset_session`
- Через HTTP: `POST http://localhost:3000/webhook/reset-session`

Сбрасывает все in-memory сессии. Следующее сообщение начнёт новый диалог.

### learnBotToken

При первом вебхуке от нового бота `service_tokens` в S3 конфиге пуст → валидация пропускается. После успешной обработки `payload.token` (это service token от Zulip) записывается в `service_tokens[]`. Со второго запроса токен проверяется.

### Zulip worker timeout

```bash
docker exec legion-zulip-1 sed -i \
  "/^class OutgoingWebhookWorker/a \ \ \ \ MAX_CONSUME_SECONDS = 120" \
  /home/zulip/deployments/current/zerver/worker/outgoing_webhooks.py
docker exec legion-zulip-1 supervisorctl restart \
  "zulip-workers:zulip_events_outgoing_webhooks"
```

---

## 6. Файловая структура

```
legion/
├── docker-compose.yml         # Все сервисы (Zulip, MinIO, Legion, RagFlow)
├── .legion/
│   ├── command/               # .md промпты (локальный кэш, primary — S3)
│   ├── integrations.jsonc     # Routing (в .gitignore)
│   ├── bots.jsonc             # Реестр ботов (в .gitignore)
│   ├── integrations.md        # Это руководство
│   ├── mcp-bot-factory/       # MCP: управление ботами (create_bot, update_bot...)
│   ├── mcp-zulip/             # MCP: Zulip API (send_message, create_stream...)
│   └── mcp-s3-storage/        # MCP: S3 storage
├── debug/
│   ├── .env                   # Конфигурация контейнера
│   ├── .env.example           # Шаблон .env с комментариями
│   ├── bootstrap.sh           # Оркестратор развёртывания
│   ├── steps/                 # Шаги bootstrap (01-09)
│   ├── lib/helpers.sh         # Общие функции для шагов
│   ├── generate_secrets.sh    # Генерация паролей Zulip
│   └── secrets/               # Пароли (в .gitignore)
├── packages/opencode/.../webhook.ts  # Обработчик вебхуков
└── .opencode/opencode.jsonc  # Конфиг opencode (MCP сервера, провайдеры)
```

---

## 7. Переменные окружения

| Переменная | Где задана | Назначение |
|-----------|-----------|------------|
| `ZULIP_URL` | docker-compose + .env | Zulip API URL внутри Docker (`https://zulip`) |
| `ZULIP_EMAIL` | .env | Админ email для API |
| `ZULIP_API_KEY` | .env (заполняется bootstrap) | API ключ админа |
| `ZULIP_API_HOST` | .env | Host header для subdomain (`legion.zulip.local:8443`) |
| `LEGION_ZULIP_URL` | docker-compose + .env | URL для скачивания файлов из Zulip |
| `LEGION_PAYLOAD_URL` | .env | Webhook URL для новых ботов (`http://legion.local:3000/webhook/zulip`) |
| `DEFAULT_MODEL` | .env | Модель по умолчанию для create_bot |
| `S3_ENDPOINT` | docker-compose + .env | MinIO endpoint (`http://minio:9000`) |
| `S3_REGION` | .env | S3 region |
| `S3_ACCESS_KEY` | .env | MinIO access key |
| `S3_SECRET_KEY` | .env | MinIO secret key |
| `S3_BUCKET` | .env | S3 bucket (`legion-bots`) |
| `OPENCODE_PRINT_LOGS=1` | .env | Вывод Effect-логов в stderr |
| `NODE_TLS_REJECT_UNAUTHORIZED=0` | .env | Отключить проверку SSL (self-signed certs) |
| `LEGION_PROJECT_DIR` | docker-compose | Корень проекта внутри контейнера (`/legion`) |

---

## 8. Известные ограничения

- **LLM API**: `opencode-go/deepseek-v4-flash` через `api.opencode.ai` может быть недоступен или сбрасывать соединение. Проверить: `curl -s https://api.opencode.ai/v1/models`
- **Zulip упоминания**: Для вызова бота в канале нужно использовать `@**имя**` (полное имя = имя команды, латиница). Email-упоминания не работают.
- **Stream context**: Загружает последние 10 сообщений. Если в теме больше — видно только последние.
- **Chunking**: Разделение по границе абзаца. Если абзац длиннее 9K символов — режется по пробелу.
- **Worker timeout**: Пропадает при пересоздании контейнера Zulip. Нужно перезапускать `08-worker-patch.sh`.
- **RagFlow**: Требует ES + MySQL, тяжеловесен. Для базовой работы не обязателен. MCP `ragflow-proxy` может быть недоступен.
