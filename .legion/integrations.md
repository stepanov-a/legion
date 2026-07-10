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
| `bot_api_keys` | нет | `{ email: api_key }` для авторизации при скачивании файлов |
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

## Команды (`.legion/command/{name}.md`)

Файлы с frontmatter и телом-шаблоном:

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

## Логирование

Каждый запрос пишется в `.legion/integration.log`:

```
RAW [zulip]: sender=Иван stream=general topic=hello contentLen=42
route: stream="general" -> "zulip"
command: zulip agent=general model=ollama/qwen2.5:3b body_chars=211
PROMPT: ...
model resolved / not found: ...
RESPONSE total=3387ms chars=38
```
