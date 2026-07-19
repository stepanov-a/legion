# Integrations config — `.legion/integrations.jsonc`

Конфиг управляет вебхуками: какие источники (Zulip, Telegram, Slack, …)
принимать, как маршрутизировать по каналам, какие команды запускать.

## Структура

```jsonc
{
  "sources": [
    {
      "name": "zulip",          // уникальное имя источника
      "type": "webhook",        // всегда "webhook"
      "endpoint": "POST /webhook/zulip",  // для справки, не влияет на регистрацию

      // Параметры для скачивания файлов (опционально)
      "zulip_url": "https://zulip.example.com",
      "bot_api_keys": {
        "bot@zulip.example.com": "api_key_here"
      },

      // Директория с .md командами (относительно корня проекта)
      "commands_dir": ".legion/command",

      // Правила маршрутизации: первое совпадение побеждает
      "routing": [
        { "stream": "research",  "command": "research" },
        { "stream": "general",   "command": "zulip" },
        { "field": "chat_id",    "pattern": "-100*", "command": "analytics" },
        { "stream": "*",         "command": "zulip" }
      ]
    }
  ],

  // Команда по умолчанию, если ни одно правило не совпало
  "default_command": "zulip"
}
```

## Поля source

| Поле | Обязательное | Описание |
|------|-------------|----------|
| `name` | да | Уникальное ID источника. Подставляется в `POST /webhook/{name}` |
| `type` | да | Всегда `"webhook"` |
| `endpoint` | нет | Для справки, в конфиге не используется |
| `zulip_url` | нет | Базовый URL Zulip-сервера для скачивания файлов |
| `tokens` | нет | `{ email: token }` для верификации запросов (сравнивается с `payload.token`) |
| `bot_api_keys` | нет | `{ email: api_key }` для авторизации при скачивании файлов |
| `s3` | нет | `{ bucket, prefix, region, endpoint }` — S3 для фоновой загрузки файлов (см. ниже) |

| `commands_dir` | нет | Путь к .md командам, по умолчанию `.legion/command` |
| `routing` | нет | Правила маршрутизации (см. ниже) |

## Routing

Правила применяются по порядку — **первое совпадение побеждает**.

```jsonc
{ "stream": "research",  "command": "research" }
```

| Поле | Описание |
|------|----------|
| `field` | Поле сообщения для сравнения: `"stream"`, `"chat_id"`. По умолчанию `"stream"` |
| `stream` / `chat_id` | Значение для сравнения (поле с тем же именем, что и `field`). `"*"` — любое |
| `command` | Имя .md файла команды (без расширения) |

### Примеры

```jsonc
"routing": [
  // Точное совпадение канала
  { "stream": "research",    "command": "research" },
  { "stream": "general",     "command": "zulip" },

  // Wildcard (любой канал)
  { "stream": "*",           "command": "zulip" },

  // По чат-ID (для Telegram)
  { "field": "chat_id", "chat_id": "-100*", "command": "analytics" },
]
```

## S3 (файловое хранилище)

При наличии блока `s3` в конфиге источника, каждый загруженный файл
автоматически сохраняется в S3 **в фоновом режиме** — HTTP-ответ
возвращается сразу, не дожидаясь S3.

```jsonc
"s3": {
  "bucket": "my-legion-bots",               // обязательное
  "prefix": "bot-files",                    // опционально, по умолчанию "files"
  "region": "eu-central-1",                 // опционально, по умолчанию us-east-1
  "endpoint": "https://s3.region.amazonaws.com"  // опционально
}
```

Путь в S3: `{prefix}/{command}/{source}/{message_id}/{filename}`
Пример: `bot-files/bashkati4/zulip/123/report.pdf`

Credentials берутся из AWS SDK chain:
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` env vars
- IAM role (в EC2 / EKS)
- `~/.aws/credentials`

## RAGFlow

При указании `ragflow_dataset` в frontmatter команды, каждый загруженный
текстовый файл автоматически загружается в RAGFlow dataset через `forkDetach`
(фоновый поток, независимый от HTTP-запроса):

```yaml
---
name: research
ragflow_dataset: research-papers
---
```

API и токен RAGFlow берутся из `.legion/legion.jsonc`:

```jsonc
"ragflow": {
  "api": "http://127.0.0.1:9380",
  "token": "ragflow-RiMTA5NmRlYWRkYjExZjBiYWVmNWVhOD"
}
```

## Команды — `.legion/command/{name}.md`

```markdown
---
name: zulip
description: "Zulip bot"
agent: general
model: ollama/qwen2.5:3b       # опционально
---

Ты — Zulip бот. Пользователь $SENDER в канале $STREAM (тема: $TOPIC):

$CONTENT

Ответь на русском.
```

### Переменные шаблона

| Переменная | Откуда берётся |
|------------|---------------|
| `$SENDER` | `message.sender_full_name` / `sender_username` |
| `$STREAM` | `message.display_recipient` / `chat` |
| `$TOPIC` | `message.topic` |
| `$CONTENT` | `message.content` / `text` |
| `$SOURCE` | Имя источника (`name` из конфига) |

### Frontmatter

| Поле | Назначение |
|------|-----------|
| `name` | Имя команды (должно совпадать с именем файла) |
| `description` | Описание (не используется) |
| `agent` | Агент opencode (по умолчанию `general`) |
| `model` | Модель в формате `providerId/modelId`, опционально |
| `mcp` | Какие MCP-серверы включены, `{ ragflow-proxy: true, github: false }` |
| `allow` | Whitelist email'ов отправителей, `["user@mail.com", "*@company.com"]` |
| `ragflow_dataset` | ID датасета в RAGFlow для фоновой загрузки файлов |

Пример:
```yaml
---
name: research
agent: general
model: ollama/qwen2.5:3b
mcp: { ragflow-proxy: true }
allow: ["ivan@company.com", "*@team.org"]
---
```

## Добавление нового источника

1. Добавить блок в `sources[]`:
   ```jsonc
   {
     "name": "telegram",
     "type": "webhook",
     "commands_dir": ".legion/command",
     "routing": [
       { "chat_id": "-100*", "command": "summarize" },
       { "chat_id": "*",     "command": "general" }
     ]
   }
   ```
2. Создать `.md` команды в `commands_dir`
3. Настроить внешнюю систему (Telegram, Slack) на `POST /webhook/telegram`
4. Никаких изменений TypeScript не требуется

## Скачивание файлов

Файлы автоматически скачиваются для источников, у которых указан `zulip_url`.
В тексте сообщения ищутся `/user_uploads/...` ссылки через regex.
Авторизация — `?api_key=<ключ бота>` из `bot_api_keys`.
Текстовые файлы (по mime или расширению) декадятся в base64 и добавляются в промпт.
Бинарные — только имя и тип.

### Git-ops: обновление конфигов без перезапуска

1. Редактируете `.md` файлы в `.legion/command/` (через git)
2. Пушите в репозиторий
3. На сервере: `git pull` в директории проекта
4. `curl -X POST http://server:3000/webhook/reload` — сброс кэша, новые команды активны

Никакого SSH/SCP, никакого перезапуска сервера.

## Логирование

Все логи через `Effect.logInfo` / `Effect.logWarning` / `Effect.logError`:
- Пишутся в `~/.local/share/opencode/log/opencode.log`
- При `--print-logs` дублируются в stderr
- Структурированный формат key=value
- Длинные значения (промпт, ответ) обрезаются до 500-1000 символов

Пример:
```
webhook.ingress source=zulip sender=Иван stream=general topic=hello contentLen=42
webhook.route matchField=stream pattern=* command=bashkati4
webhook.prompt text="Ты — агент-онтолог..."
webhook.model_resolved model=ollama/qwen2.5
webhook.session cacheKey=zulip:general:hello sessionID=ses_wh_...
webhook.done source=zulip command=bashkati4 totalTime=3387 len=38 text=Привет...
```

### Таймауты

Zulip outgoing webhook по умолчанию ждёт ответ **10 секунд**. Если модель
медленная (Ollama без GPU, RAGFlow, большие файлы) — таймаут может не
хватить, пользователь увидит `Bot is unavailable`.

Для Zulip в Docker расширяется переменной окружения:

```yaml
environment:
  SETTING_OUTGOING_WEBHOOK_TIMEOUT_SECONDS: "120"
```

Для других источников (Telegram, Slack) — настраивается на стороне
отправителя.
