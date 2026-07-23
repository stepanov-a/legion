# Legion Setup Guide

Полное развёртывание инфраструктуры Legion: Zulip + MinIO + OpenCode.

## Требования

- Linux (рекомендуется Ubuntu 22.04+)
- Docker + Docker Compose v2
- Git
- 4+ GB RAM (8+ рекомендуется)
- Доступ к `https://opencode.ai/zen/go/v1` (модель LLM)

## Быстрый старт

```bash
# 1. Клонировать репозиторий
git clone <repo-url> legion
cd legion

# 2. Настроить .env
cp debug/.env.example debug/.env
# Отредактировать debug/.env:
#   OPENCODE_API_KEY — API-ключ для opencode-go/deepseek-v4-flash
#   RAGFLOW_TOKEN — токен RAGFlow (если используется)

# 3. Сгенерировать секреты Zulip
bash debug/generate_secrets.sh

# 4. Запустить инфраструктуру
docker compose up -d
# MinIO → zulip-database → zulip → legion

# 5. Дождаться готовности Zulip
docker inspect legion-zulip-1 --format '{{.State.Health.Status}}'
# Должен быть "healthy" (~1-3 минуты)

# 6. Создать организацию и админа
docker exec legion-zulip-1 su zulip -c '
  /home/zulip/deployments/current/manage.py create_realm \
    "Legion" a.stepanov@2035.university "Admin" --string-id=legion
'

# 7. Настроить админа
docker exec legion-zulip-1 su zulip -c "
  /home/zulip/deployments/current/manage.py shell -c '
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
print(\"ok\")
'
"

# 8. Получить API-ключ
API_KEY=\$(curl -sk "https://localhost:8443/api/v1/fetch_api_key" \
  -H "Host: legion.zulip.local:8443" \
  -d "username=a.stepanov@2035.university" \
  -d "password=legion-admin-2025" | python3 -c "import sys,json;print(json.load(sys.stdin).get('api_key',''))")
echo \$API_KEY

# 9. Записать ключ в .env
sed -i "s/^ZULIP_API_KEY=.*/ZULIP_API_KEY=\$API_KEY/" debug/.env
sed -i "s/^ZULIP_API_KEY=.*/ZULIP_API_KEY=\$API_KEY/" .env

# 10. Создать ботов
for bot_name in adminbotv2 consultantbot; do
  curl -sk -X POST "https://localhost:8443/api/v1/bots" \
    -H "Host: legion.zulip.local:8443" \
    -u "a.stepanov@2035.university:\$API_KEY" \
    -d "full_name=\$bot_name" \
    -d "short_name=\$bot_name" \
    -d "bot_type=3" \
    -d 'payload_url="http://legion.local:3000/webhook/zulip"'
done

# 12. Записать bots.jsonc (см. раздел Конфигурация ниже)

# 13. Перезагрузить Legion
curl -sk http://localhost:3000/webhook/reload -X POST
```

## Пошагово (без автоматизации)

### 1. Секреты

```bash
bash debug/generate_secrets.sh
```

Создаёт файлы в `debug/secrets/`:

| Файл | Назначение |
|---|---|
| `zulip__postgres_password` | Пароль PostgreSQL |
| `zulip__memcached_password` | Пароль Memcached |
| `zulip__rabbitmq_password` | Пароль RabbitMQ |
| `zulip__redis_password` | Пароль Redis |
| `zulip__secret_key` | Django Secret Key |
| `zulip__email_password` | SMTP пароль (заглушка) |

### 2. Переменные окружения

В `debug/.env` и `.env`:

```ini
# ── Администратор Zulip ──────────────────────────
ZULIP_ADMIN_EMAIL=a.stepanov@2035.university
ZULIP_ADMIN_PASSWORD=legion-admin-2025
ZULIP_API_KEY=<получить_из_шага_8>

# ── Доступ к Zulip API (из контейнера Legion) ────
ZULIP_URL=https://zulip
ZULIP_EMAIL=a.stepanov@2035.university
ZULIP_API_HOST=legion.zulip.local:8443

# ── S3 (MinIO) ───────────────────────────────────
S3_REGION=us-east-1
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=legion-bots

# ── URL для вебхуков ботов ───────────────────────
LEGION_PAYLOAD_URL=http://legion.local:3000/webhook/zulip

# ── LLM API-ключ (обязательно) ──────────────────
OPENCODE_API_KEY=<ваш_ключ>

# ── RAGFlow (опционально) ────────────────────────
RAGFLOW_API=http://172.18.0.1:59380
RAGFLOW_TOKEN=<токен>
```

### 3. Запуск контейнеров

```bash
# Зависимости Zulip (без RagFlow)
docker compose up -d \
  zulip-database zulip-memcached zulip-rabbitmq zulip-redis \
  minio minio-setup

# Минуту подождать, затем Zulip
docker compose up -d zulip
# ~1-3 минуты на инициализацию

# Legion
docker compose up -d legion
```

### 4. Доступ к Zulip

```
https://localhost:8443
```

Сертификат самоподписанный — принять исключение в браузере.

Логин: `a.stepanov@2035.university`
Пароль: `legion-admin-2025`

### 5. Конфигурация ботов

Файл `integrations.jsonc`:

```jsonc
{
  "sources": [{
    "name": "zulip",
    "routing": [
      { "field": "bot_email", "bot_email": "adminbotv2-bot@zulip.local", "command": "admin" },
      { "field": "bot_email", "bot_email": "steven-bot@zulip.local", "command": "steven" }
    ]
  }]
}
```

Routing только по `bot_email`. Каналы не используются.

Файл `.legion/bots.jsonc`:

```jsonc
{
  "bots": [
    {
      "name": "admin",
      "description": "Админские команды",
      "agent": "general",
      "model": "opencode-go/deepseek-v4-flash",
      "mcp": {"bot-factory": true, "zulip-messages": true},
      "allow": ["a.stepanov@2035.university"],
      "zulip_email": "adminbotv2-bot@zulip.local",
      "zulip_api_key": "<ключ>",
      "zulip_user_id": 9
    }
  ]
}
```

Поля:

| Поле | Описание |
|---|---|
| `name` | Имя команды (файл `.legion/command/{name}.md`) |
| `mcp` | Какие MCP-инструменты доступны боту |
| `allow` | Whitelist email'ов (пусто — всем) |
| `zulip_email` | Email бота в Zulip |
| `zulip_api_key` | API-ключ бота |
| `zulip_user_id` | ID бота в Zulip |
| `service_tokens` | Токены для валидации вебхуков (заполняется автоматически) |

### 6. Синхронизация с S3

```bash
docker cp /tmp/bots_data.json legion-legion-1:/tmp/bots_data.json

docker exec legion-legion-1 bash -c '
cat > /tmp/sync.ts << EOF
import {S3Client,PutObjectCommand} from "@aws-sdk/client-s3"
import * as fs from "fs"
const s3=new S3Client({region:"us-east-1",endpoint:"http://minio:9000",credentials:{accessKeyId:"minioadmin",secretAccessKey:"minioadmin"},forcePathStyle:true})
const BOTS=JSON.parse(fs.readFileSync("/legion/.legion/bots.jsonc","utf-8")).bots
const BD=JSON.parse(fs.readFileSync("/tmp/bots_data.json","utf-8"))
for (const bot of BOTS) {
  const bd=BD[bot.name]
  await s3.send(new PutObjectCommand({Bucket:"legion-bots",Key:"bot-prompts/"+bot.name+"/config.json",Body:JSON.stringify({...bot,service_tokens:bd?.stoken?[bd.stoken]:[]},null,2),ContentType:"application/json"}))
}
// Все .md файлы
for (const f of fs.readdirSync("/legion/.legion/command").filter(f=>f.endsWith(".md"))) {
  const name=f.replace(/\.md$/,"")
  const content=fs.readFileSync("/legion/.legion/command/"+f,"utf-8")
  await s3.send(new PutObjectCommand({Bucket:"legion-bots",Key:"bot-prompts/"+name+"/prompt.md",Body:content,ContentType:"text/markdown"}))
}
EOF
bun run /tmp/sync.ts
'

curl -sk http://localhost:3000/webhook/reload -X POST
```

### 7. Проверка

```bash
# Статус контейнеров
docker compose ps

# Логи Legion
docker logs legion-legion-1 2>&1 | tail -20

# Тест вебхука
curl -sk "http://localhost:3000/webhook/zulip" -X POST \
  -H "Content-Type: application/json" \
  -d '{"bot_email":"adminbotv2-bot@zulip.local","token":"","message":{"sender_email":"a.stepanov@2035.university","sender_full_name":"Admin","content":"привет","type":"private","display_recipient":"dm"}}'
# Ожидается: {"content":"✅"}

# Написать в Zulip админ-боту:
#   adminbotv2-bot@zulip.local → "список ботов"
```

## Архитектура

```
┌──────────┐  ┌──────────┐  ┌──────────┐
│  Zulip   │  │  MinIO   │  │  Legion  │
│ :8443    │  │ :9000    │  │ :3000    │
└────┬─────┘  └────┬─────┘  └────┬─────┘
     │              │              │
     └──────────────┴──────────────┘
            legion-net (172.18.0.0/16)
```

Все сервисы общаются по Docker DNS внутри сети `legion-net`. Legion имеет статический IP `172.18.0.10` — он используется как payload URL для вебхуков Zulip.

### Компоненты

| Компонент | Роль |
|---|---|
| **Zulip** | Чат-интерфейс, outgoing webhooks → Legion |
| **MinIO** | S3-совместимое хранилище (промпты, конфиги, файлы) |
| **Legion** | OpenCode server — LLM + MCP-инструменты |
| **MCP-серверы** | Subprocess внутри Legion: zulip, s3-storage, web-search, zulip-messages, deep-research, bot-factory |

### Поток сообщения

```
Пользователь → @упоминание бота в Zulip
  → Outgoing webhook POST /webhook/zulip
    → Legion: routing по bot_email → .md команда
      → LLM + MCP инструменты → Ответ
        → sendZulipReply() в Zulip
```

**Каналы (stream) для ботов не используются.** Routing только по `bot_email`. Бот отвечает на @упоминания из любого канала.

## MCP-серверы

| MCP | Инструменты | Назначение |
|---|---|---|
| `bot-factory` | create_bot, list_bots, get_bot, update_bot, delete_bot, reset_session | Управление ботами |
| `zulip` | send_message, create_stream, list_streams, search_messages, get_stream_topics, subscribe_users, get_user, create_bot, deactivate_bot | Zulip API |
| `zulip-messages` | forward_to_bot, list_bots, list_conversations | Межботовая коммуникация |
| `s3-storage` | write_file, read_file, list_files, move_file, delete_file, get_share_link | S3 файлы |
| `web-search` | web_search, read_url | Поиск в интернете (DuckDuckGo) |
| `deep-research` | deep_research, deepen_research | Глубокий поиск (веб + RAGFlow) |
| `ragflow-proxy` | ensure_dataset, create_dataset, search_retrieval, list_datasets, list_documents, upload_document, get_chunks | RAGFlow knowledge base |
| `presentation` | create_presentation, analyze_presentation, update_slide, convert_to_pdf | Презентации |
| `tables` | read_table, write_table, transform_table, find_errors | Таблицы (Excel/CSV) |
| `media` | analyze_media, extract_audio, generate_image, extract_metadata | Медиа |

## RAGFlow (опционально)

RAGFlow вынесен в отдельный compose-файл:

```bash
docker compose -f docker-compose.ragflow.yml up -d
```

Требует ~8GB RAM и ~5 минут на запуск (ES + MySQL + Redis).

Параметры подключения (уже в `.env`):
- `RAGFLOW_API=http://172.18.0.1:59380`
- `RAGFLOW_TOKEN=<токен>`

## Создание нового бота

Через админ-бота в Zulip:

```
Admin: создай бота "expert" с каналом "expert-chan"
Admin Bot: ✅ Бот создан. Email: expert-bot@zulip.local, API Key: ...
```

Или напрямую через `create_bot` MCP:

```
create_bot(
  name: "expert",
  description: "Бот-эксперт",
  prompt: "...",
  stream: "expert-chan"
)
```

Параметры `create_bot`:

| Параметр | По умолч. | Описание |
|---|---|---|
| `name` | — | Имя команды (латиница) |
| `description` | — | Описание |
| `prompt` | — | Текст промпта |
| `stream` | `*` | Не используется — боты работают через @упоминание |
| `agent` | `general` | Тип агента |
| `model` | `opencode-go/deepseek-v4-flash` | Модель LLM |
| `forwarding` | `true` | Добавить инструкцию пересылки |
| `ragflow_storage` | `true` | Добавить инструкцию RAGFlow |
| `self_update` | `false` | Добавить самообновление |
| `mcp` | все | MCP-инструменты |
| `allow` | — | Whitelist email'ов |

## Переменные окружения (полный список)

| Переменная | Обязательно | Дефолт | Описание |
|---|---|---|---|
| `OPENCODE_API_KEY` | ✅ | — | API-ключ для LLM |
| `ZULIP_ADMIN_EMAIL` | ✅ | `a.stepanov@2035.university` | Email админа Zulip |
| `ZULIP_ADMIN_PASSWORD` | ✅ | `legion-admin-2025` | Пароль админа |
| `ZULIP_API_KEY` | ✅ | — | API-ключ Zulip (получить после создания realm) |
| `ZULIP_URL` | — | `https://zulip` | Внутренний URL Zulip |
| `ZULIP_API_HOST` | — | `legion.zulip.local:8443` | Host header для Zulip |
| `S3_ENDPOINT` | — | `http://minio:9000` | MinIO endpoint |
| `S3_ACCESS_KEY` | — | `minioadmin` | MinIO access key |
| `S3_SECRET_KEY` | — | `minioadmin` | MinIO secret key |
| `S3_BUCKET` | — | `legion-bots` | S3 bucket |
| `LEGION_PAYLOAD_URL` | — | `http://legion.local:3000/webhook/zulip` | URL вебхука для ботов |
| `RAGFLOW_API` | — | — | RAGFlow API URL |
| `RAGFLOW_TOKEN` | — | — | RAGFlow API токен |
| `LEGION_RELOAD_URL` | — | `http://localhost:3000/webhook/reload` | URL перезагрузки |
| `LEGION_RESET_SESSION_URL` | — | `http://localhost:3000/webhook/reset-session` | URL сброса сессий |
| `LEGION_WEBHOOK_URL` | — | `http://localhost:3000/webhook/zulip` | URL внутреннего вебхука |
| `DDG_SEARCH_URL` | — | `https://html.duckduckgo.com/html/` | DuckDuckGo search URL |

## Известные ограничения

1. **Не редактировать исходники Zulip** — все настройки через `SETTING_*` env vars в docker-compose.yml
2. **LLM API** — `opencode-go/deepseek-v4-flash` через `https://opencode.ai/zen/go/v1`, требует `OPENCODE_API_KEY`
3. **Таймаут LLM** — 120 секунд (настраивается в webhook.ts)
4. **Таймаут вебхука Zulip** — 60 секунд (через `SETTING_OUTGOING_WEBHOOK_TIMEOUT_SECONDS`)
5. **Статический IP Legion** — `172.18.0.10` (payload_url ботов не меняется после рестарта)
6. **Routing только по bot_email** — каналы не используются, боты работают через @упоминание
7. **`send_as_bot` удалён** — Zulip не триггерит вебхуки на сообщения от ботов, используйте `forward_to_bot`
