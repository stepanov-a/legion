- To regenerate the legacy JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- After changing the public Protocol or Server `HttpApi`, run `bun run generate` from `packages/client`. Do not edit `src/generated` or `src/generated-effect` directly.
- Keep runtime dependencies directed from Schema to Core and Protocol, then from Core and Protocol to Server. Client runtime code may depend on Schema and Protocol but never Core or Server; `sdk-next` composes Client, Core, and Server.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.

## Branch Names

Use a short branch name of at most three words, separated by hyphens. Do not use slashes or type prefixes such as `feat/` or `fix/`.

Examples: `session-recovery`, `fix-scroll-state`, `regenerate-sdk`.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful, e.g. `core`, `opencode`, `tui`, `app`, `desktop`, `sdk`, or `plugin`.

Examples: `fix(tui): simplify thinking toggle styling`, `docs: update contributing guide`, `chore(sdk): regenerate types`.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.
- In Effect generators, bind services to named variables before calling methods. Do not use nested service yields such as `yield* (yield* Foo.Service).bar()`.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Imports

- Never alias imports. Do not use `import { foo as bar } from "..."` or renamed imports like `resolve as pathResolve`.
- Never use star imports. Do not use `import * as Foo from "..."` or `import type * as Foo from "..."`.
- If a namespace-style value is needed, import the module's own exported namespace by name, for example `import { Project } from "@opencode-ai/core/project"`, then reference `Project.ID`.
- Prefer dynamic imports for heavy modules that are only needed in selected code paths, especially in startup-sensitive entrypoints. Destructure dynamic import bindings near the top of the narrowest scope that needs them so they read like normal imports. Avoid inline chains such as `await import("./module").then((mod) => mod.value())` or `(await import("./module")).value()`. Keep branch-specific imports inside the branch that needs them to preserve lazy loading.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Do not return `Effect` from helpers unless they actually perform effectful work. Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible, you shouldn't be using globalThis.\* at all unless it's the only option.
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.

## V2 Session Core

- Keep durable prompt admission separate from model execution. `SessionV2.prompt(...)` admits one durable `session_input` row before scheduling advisory `SessionExecution.wake(sessionID)` unless `resume: false` requests admit-only behavior. The serialized runner promotes admitted inputs into visible user messages at safe boundaries.
- Reusing a Session ID adopts the existing Session. Reusing a prompt message ID reconciles an exact retry only when Session, prompt, and delivery mode match; conflicting reuse fails. Historical projected prompts lazily synthesize promoted inbox records during exact retry.
- Keep `SessionExecution` process-global and Session-ID based. Its local implementation owns the process-local Session coordinator and discovers placement through `SessionStore` plus `LocationServiceMap.get(session.location)` only when a drain starts; no layer should take a Session ID. V2 interruption targets the active process-local ownership chain for that Session; idle or missing interruption is a no-op.
- Keep `SessionRunner`, model resolution, tool registry, permissions, and filesystem Location-scoped. Omitted `Location.workspaceID` means implicit-local placement; explicit workspace identity remains reserved for future placement semantics.
- Preserve one explicit `llm.stream(request)` call per provider turn and reload projected history before durable continuation. Do not bridge through legacy `SessionPrompt.loop(...)` or delegate orchestration to an in-memory tool loop.
- Keep local Session drains process-local until clustering is implemented. `SessionRunCoordinator` joins explicit same-Session resumes, coalesces prompt wakeups, and allows different Sessions to run concurrently. Advisory wakes drain eligible durable inbox rows only; post-crash continuation recovery requires a separate explicit design before it may retry provider work. A drain has no durable identity or transcript boundary.
- Keep delivery vocabulary explicit. Prompts steer by default and promote at the next safe provider-turn boundary while the current drain requires continuation. An explicit `queue` input remains pending until the Session would otherwise become idle; promote one queued input at that boundary, then reevaluate continuation before promoting another. Promoting any new user input resets the selected agent's provider-turn allowance; a batch of steers resets it once.
- Keep EventV2 replay owner claims separate from clustered Session execution ownership.
- Keep the System Context algebra, registry, and built-ins in `src/system-context`; keep Context Source producers with their observed domains, and keep Session History selection plus Context Epoch persistence Session-owned.

## Webhook Integration Pipeline

### Архитектура

```
Source → POST /webhook/:source
  → Schema.Unknown (любой JSON-тело)
  → WebhookContextMiddleware (предоставляет InstanceRef)
  → handler (generic):
      1. Парсинг payload (source-specific поля)
      2. Поиск /user_uploads/... в content → скачивание файлов
      3. Чтение .legion/integrations.jsonc → source config
      4. Routing: первое совпадение stream/chat_id → command
      5. Чтение команды .legion/command/{name}.md
      6. Рендер шаблона ($SENDER, $STREAM, $TOPIC, $CONTENT, $SOURCE)
      7. Allow check (whitelist sender_email)
      8. Выбор модели из frontmatter команды:
         - model указана → Provider.Service.getModel()
           - найдена → используется
           - не найдена → ❌ ошибка
         - model нет → дефолтный провайдер (opencode-go)
      9. SessionPrompt.Service.prompt() — всегда, MCP инструменты доступны
  → 200 { content: "..." } → Source публикует ответ
```

Все вызовы идут через `SessionPrompt.Service.prompt()`, что даёт:
- MCP-инструменты (ragflow-proxy, search_retrieval, …)
- Правильную маршрутизацию провайдера
- Обработку ошибок

---

### Файлы в `packages/opencode/src/server/routes/instance/httpapi/`

#### `groups/webhook.ts`
Универсальный эндпоинт `POST /webhook/:source`.
- `:source` — имя из `integrations.jsonc` (zulip, telegram, …)
- Payload: `Schema.Unknown` (любой JSON, без валидации)
- Response: `{ content: string }`
- Подключен `WebhookContextMiddleware`

#### `handlers/webhook.ts`
**Основной хендлер.** Вся логика обработки.

**Парсинг payload:**
- `sender = sender_full_name ?? sender_username ?? from`
- `content = content ?? text`
- `stream = display_recipient ?? chat`
- `sender_email = sender_email`

**Скачивание файлов:**
- `/user_uploads/...` ссылки ищутся в тексте сообщения через regex
- Скачиваются с Zulip-сервера через `?api_key=<ключ бота>`
- Текстовые файлы (по mime или расширению из `TEXT_EXTS`) — содержимое добавляется в промпт (первые 3000 символов)
- Бинарные — только имя и тип
- Если для бота нет ключа в `bot_api_keys` — файл пропускается (безопасно)

**Routing:**
- `.legion/integrations.jsonc` читается на каждый запрос
- Правила применяются по порядку: первое совпадение → команда
- Поддерживаются поля `stream` и `chat_id` (для Telegram)

**Парсинг frontmatter команды (regex, не YAML):**
- `agent` — имя агента opencode
- `model` — `providerId/modelId`
- `mcp` — `{ ragflow-proxy: true }` — какие MCP разрешены
- `allow` — `["user@mail.com", "*@domain.com"]` — whitelist sender_email

**Выбор модели:**
- Если в frontmatter указана `model: ollama/qwen2.5`:
  - `Provider.Service.getModel("ollama", "qwen2.5")` — проверяет наличие
  - Если найдена → передаётся в `sessionPrompt.prompt()`
  - Если не найдена → возвращается `❌ Модель не найдена`
- Если model не указана → используется дефолтный провайдер `opencode-go`

**Allow check:**
- Если `allow: ["a@b.com", "*@domain.com"]` — проверяется sender_email
- Поддерживаются wildcard: `*@domain.com`, `prefix*`
- Если allow пустой или отсутствует — доступ открыт всем
- Если не совпало — `❌ Access denied.`

**MCP-инструменты:**
- Передаются через `input.tools` в `sessionPrompt.prompt()`
- Если в frontmatter указано `mcp: { ragflow-proxy: true }` — только указанные
- Если mcp пустой или отсутствует — все MCP-серверы из конфига

**Логирование:**
- Синхронный `fs.appendFileSync` в `.legion/integration.log`
- Каждая стадия: RAW, routing, command, PROMPT, model resolution, RESPONSE
- Полный текст промпта и ответа

#### `webhook.ts`
Сборка `PublicWebhookApi` из `WebhookApi`. 4 строки.

#### `server.ts`
```ts
import { PublicWebhookApi } from "./webhook"
import { webhookHandlers } from "./handlers/webhook"
import { webhookContextLayer } from "./middleware/webhook-context"
const webhookApiRoutes = HttpApiBuilder.layer(PublicWebhookApi).pipe(
  Layer.provide(webhookHandlers),
  Layer.provide(webhookContextLayer),
)
// + в Layer.mergeAll
```

#### `middleware/webhook-context.ts`
Middleware, которая предоставляет `InstanceRef` для webhook-запросов.

Стандартный `instanceContextLayer` требует `WorkspaceRouteContext` (директория из URL). У публичного вебхука `/webhook/:source` нет workspace в URL, поэтому сделан отдельный middleware, который загружает InstanceRef для фиксированной директории `PROJECT_ROOT`.

Если загрузка не удалась — middleware пропускает запрос без InstanceRef (хендлер работает с дефолтами).

---

### Файлы конфигурации (`.legion/`)

#### `.legion/integrations.jsonc`
Главный конфиг: источники, routing, bot_api_keys.

```jsonc
{
  "sources": [
    {
      "name": "zulip",                    // ID источника (совпадает с :source в URL)
      "type": "webhook",                   // всегда "webhook"
      "endpoint": "POST /webhook/zulip",   // для справки
      "zulip_url": "https://zulip.local:8443",     // для скачивания файлов
      "commands_dir": ".legion/command",            // где лежат .md команды
      "bot_api_keys": {                             // email бота → API key
        "bashkati4-bot@zulip.local": "8UXn81E..."
      },
      "routing": [
        { "stream": "admin",     "command": "admin" },
        { "stream": "research",  "command": "bashkati4" },
        { "stream": "*",         "command": "bashkati4" }
      ]
    }
  ],
  "default_command": "bashkati4"
}
```

**Поля source:**

| Поле | Обязательное | Описание |
|------|:-----------:|----------|
| `name` | да | ID источника, подставляется в `/webhook/{name}` |
| `endpoint` | нет | Для справки |
| `zulip_url` | нет | Базовый URL Zulip-сервера для скачивания файлов |
| `commands_dir` | нет | Путь к .md командам, по умолчанию `.legion/command` |
| `tokens` | нет | `{ email: token }` для верификации запросов (сравнивается с `payload.token`) |
| `bot_api_keys` | нет | `{ email: api_key }` для авторизации при скачивании |

| `routing` | нет | Правила маршрутизации |

**Routing:**

Правила применяются по порядку — первое совпадение побеждает.

```jsonc
{ "stream": "research",  "command": "research" }
{ "field": "chat_id", "chat_id": "-100*", "command": "analytics" }
{ "stream": "*",         "command": "bashkati4" }
```

| Поле | Описание |
|------|----------|
| `field` | Поле для сравнения: `"stream"`, `"chat_id"`. По умолчанию `"stream"` |
| `stream` / `chat_id` | Значение для сравнения. `"*"` — любое |
| `command` | Имя .md файла команды (без расширения) |

#### `.legion/command/{name}.md`
Команды — inline-определения в `integrations.jsonc` (поле `commands`) или `.md` файлы в `commands_dir`. Inline имеют приоритет.

**Frontmatter:**

```yaml
---
name: bashkati4
description: "Запрос к агент-онтологу"
agent: general
model: ollama/qwen2.5
mcp: { ragflow-proxy: true }
allow: ["a@b.com", "*@domain.com"]
---
```

| Поле | Описание |
|------|----------|
| `name` | Имя команды |
| `description` | Описание |
| `agent` | Агент opencode (по умолчанию `general`) |
| `model` | Модель `providerId/modelId` (опционально). Если указана — ищется в глобальном конфиге, иначе ошибка |
| `mcp` | Какие MCP-серверы разрешены, `{ ragflow-proxy: true }`. Если не указан — все |
| `allow` | Whitelist sender_email'ов, `["*@company.com"]`. Если не указан — все |

**Переменные шаблона:**

| Переменная | Откуда |
|------------|--------|
| `$SENDER` | `sender_full_name` / `sender_username` / `from` |
| `$STREAM` | `display_recipient` / `chat` |
| `$TOPIC` | `topic` |
| `$CONTENT` | `content` / `text` |
| `$SOURCE` | `source.name` из конфига |

**Пример:**
```markdown
---
name: bashkati4
agent: general
model: ollama/qwen2.5
---

Пользователь $SENDER написал в канале $STREAM (тема: $TOPIC):

$CONTENT

Твоя задача — отвечать в рамках мышления Башкатыча:

- Начинай не с ответа, а с направления
- Ищи архитектуру, а не факты
- Проверяй на жизнеспособность, а не на логичность
```

#### `.legion/legion.jsonc`
Provider config для opencode. MCP-серверы (ragflow-proxy) подхватываются `SessionPrompt.Service.prompt()` и доступны агенту.

#### `~/.config/opencode/opencode.json`
**Глобальный** конфиг opencode. Провайдеры отсюда загружаются при старте сервера (InstanceRef не нужен). Если модель указана в frontmatter команды, она должна быть определена здесь.

```jsonc
{
  "provider": {
    "ollama": {
      "name": "Ollama",
      "api": "http://localhost:11434/v1",
      "npm": "@ai-sdk/openai-compatible",
      "models": {
        "qwen2.5": { "id": "qwen2.5:3b", "tools": true }
      }
    }
  }
}
```

### RAGFlow (фоновое индексирование)

При указании `ragflow_dataset` в frontmatter команды, каждый загруженный
текстовый файл автоматически загружается в RAGFlow dataset через `forkDetach`
(фоновый поток, независимый от HTTP-запроса):

```yaml
---
name: bashkati4
ragflow_dataset: research-papers
---
```

API и токен — из `.legion/legion.jsonc`:

### S3 (файловое хранилище)

При указании `s3` в конфиге источника, каждый загруженный файл
автоматически сохраняется в S3 через `forkDetach` (фоновый Effect-поток,
независимый от родительского HTTP-запроса):

```jsonc
"s3": {
  "bucket": "my-legion-bots",
  "prefix": "bot-files",
  "region": "eu-central-1",
  "endpoint": "https://s3.eu-central-1.amazonaws.com"
}
```

Путь в S3: `{prefix}/{command}/{source}/{message_id}/{filename}`.
Credentials — из AWS SDK chain (env vars, IAM role, файл).

### Таймауты на стороне вызывающей системы

Zulip outgoing webhook по умолчанию ждёт ответ 10 секунд
(`OUTGOING_WEBHOOK_TIMEOUT_SECONDS = 10`). Для медленных моделей (Ollama,
RAGFlow) этого может не хватить. Рекомендуется расширять таймаут.

Для Zulip в Docker — добавить переменную в `environment`:

```yaml
environment:
  SETTING_OUTGOING_WEBHOOK_TIMEOUT_SECONDS: "120"
```

Для других источников (Telegram, Slack, HTTP-вызовы) — настроить таймаут
на стороне отправителя. Без таймаута внешняя система может:
- Разорвать соединение по таймауту
- Показать пользователю `Bot is unavailable`
- Отправить повторный запрос (дубликат)

### Логирование

Все логи через `Effect.logInfo` / `Effect.logWarning` / `Effect.logError`:
- Пишутся в `~/.local/share/opencode/log/opencode.log`
- При `--print-logs` дублируются в stderr
- Структурированный формат key=value, удобный для grep и агрегации (Loki, ELK, CloudWatch)
- Длинные значения (промпт, ответ) обрезаются до 500-1000 символов
- Полные промпты и ответы — через Langfuse / OpenTelemetry

Примеры логов:
```
webhook.ingress source=zulip sender=Иван stream=general topic=t contentLen=42
webhook.route matchField=stream pattern="*" command=bashkati4
webhook.done source=zulip command=bashkati4 totalTime=3387 len=38 text=Привет...
```

### Git-ops: обновление конфигов без перезапуска

1. Редактируете `.md` файлы в `.legion/command/` (через git)
2. Пушите в репозиторий
3. На сервере: `git pull` в директории проекта
4. `curl -X POST http://server:3000/webhook/reload` — сброс кэша, новые команды активны

Никакого SSH/SCP, никакого перезапуска сервера.

### Как добавить новый источник

1. Добавить блок в `sources[]` `integrations.jsonc`:
   ```jsonc
   {
     "name": "telegram",
     "type": "webhook",
     "commands_dir": ".legion/command",
     "routing": [
       { "chat_id": "-100*", "command": "analytics" },
       { "chat_id": "*",     "command": "general" }
     ]
   }
   ```
2. Создать .md команды в `commands_dir`
3. Настроить внешнюю систему на `POST /webhook/telegram`
4. Никаких изменений TypeScript не требуется

### Как добавить команду

1. Создать `.legion/command/{name}.md` с frontmatter и телом
2. Указать `command: {name}` в routing правиле

### Как работает модель из frontmatter

1. В frontmatter указано `model: ollama/qwen2.5`
2. Хендлер парсит `ollama/qwen2.5` → `providerID="ollama"`, `modelID="qwen2.5"`
3. `Provider.Service.getModel("ollama", "qwen2.5")` — ищет в глобальном конфиге
4. Если найдена → `sessionPrompt.prompt()` использует эту модель
5. Если не найдена → возвращается `❌ Модель не найдена.`

Провайдер должен быть определён в `~/.config/opencode/opencode.json` (глобальный конфиг), т.к. `Provider.Service` инициализируется при старте сервера.

### Как работает allow (whitelist)

1. В frontmatter указано `allow: ["*@company.com"]`
2. Хендлер проверяет `sender_email` из payload
3. Поддерживаются wildcard: `*@company.com`, `prefix*`
4. Если allow пустой или не указан — доступ открыт всем
5. Если не совпало — `❌ Access denied.`

### Как работают MCP-инструменты

1. MCP-серверы настраиваются в `.legion/legion.jsonc`
2. Всегда выполняются через `SessionPrompt.Service.prompt()`, который подхватывает `ToolRegistry` со всеми MCP
3. Если в frontmatter указано `mcp: { ragflow-proxy: true }` — передаётся как `input.tools`, opencode ограничивает доступные инструменты
4. Если `mcp` не указан — доступны все инструменты

### Известные ограничения

- `Command.Service` не используется. Команды читаются из `.legion/command/*.md`.
- Провайдеры из `.legion/legion.jsonc` не загружаются в `Provider.Service` из-за отсутствия `InstanceRef` при старте. Провайдеры должны быть в глобальном `~/.config/opencode/opencode.json`.
- `SessionPrompt.Service.prompt()` может висеть при использовании медленных моделей (Ollama). Рекомендуется таймаут на стороне вызывающей системы (см. ниже).
