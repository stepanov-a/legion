# Интеграция MCP-серверов с Effect — план

После деплоя текущей ветки. Код существующих серверов и вебхука **не меняется**, пока новый слой не готов и не протестирован.

---

## ⚡ quick wins (безопасно сейчас)

### Q1. Кэш для getBotApiKey

`webhook.ts` сейчас ходит в S3 за API-ключом бота при каждом сообщении (строки 430-432, 441-442). Если S3 лежит — боты молчат.

Добавить Map-кэш в `webhook.ts` с TTL. ~10 строк.

### Q2. Выделить `shared/parse-frontmatter.ts`

Текущий regex-парсер из `webhook.ts` (строки 70-93) вынести в отдельный файл. Ничего не менять — просто переместить. 
- `webhook.ts` импортирует готовую функцию
- `mcp-bot-factory` и его `parseFrontmatter` (строки 85-96) НЕ меняются — только если решат импортировать общий

Останавливает дрейф: если кто-то правит парсер — правит в одном месте.

---

## Уровень 1: SDK для MCP-серверов

Каждый MCP-сервер сейчас содержит ~50 строк boilerplate: stdin-цикл, `respond()`, `initialize`, `tools/list`, `tools/call`.

Вынести в `packages/opencode/src/legion/shared/mcp-transport.ts`:

```ts
export function runMcpServer(tools: ToolDef[], handler: ToolHandler): never
```

Каждый сервер превращается в:
```ts
import { runMcpServer } from "../../packages/opencode/src/legion/shared/mcp-transport"
runMcpServer(tools, handleToolCall)
```

**Эффект:** `-350` строк суммарно.

---

## Уровень 2: Effect-сервисы для стыковки с OpenCode

### Архитектура

```
packages/schema/src/legion/        ← чистые Schema-типы (без runtime)
packages/opencode/src/legion/
  shared/                           ← чистые TS-функции (импорт MCP-серверами и Effect)
    parse-frontmatter.ts
    bot-config.ts
    routing.ts
  zulip-client.ts                   ← Effect-клиент Zulip API (HttpClient)
  bot-registry.ts                   ← Effect-обёртка над shared/bot-config.ts
  command-loader.ts                 ← Effect-обёртка над shared/parse-frontmatter.ts
  routing-svc.ts                    ← Effect-обёртка над shared/routing.ts
  webhook-pipeline.ts               ← композиция (замена webhook.ts)
```

### Принципы

- **Zulip HTTP — только Effect-сервис.** Никакого `shared/zulip-fetch.ts`. MCP-сервера `mcp-zulip` и `mcp-bot-factory` остаются со своими inline fetch (они минимальны и специфичны).
- **Логика чистая — в shared-функциях.** Effect-сервисы только прикручивают её к OpenCode runtime (логирование, сессии, HTTP-клиент).
- **Shared-функции в `packages/opencode/src/legion/shared/`**, не в `.legion/shared/`. MCP-сервера импортируют по относительному пути (он стабилен).
- **Сначала типы** в `packages/schema/src/legion/` — без зависимостей от runtime.

### Состав shared-функций

| Файл | Содержит |
|---|---|
| `parse-frontmatter.ts` | `parse()`, `buildFrontmatter()`, `render()` |
| `bot-config.ts` | `BotEntry`, CRUD для `bots.jsonc`, S3 sync |
| `routing.ts` | `loadRoutingConfig()`, `resolveRoute()`, `addRoute()` |

### Состав Effect-сервисов

| Сервис | Назначение |
|---|---|
| `ZulipClient` | Admin-методы (из конфига), bot-методы (с переданными кредами), downloadFile |
| `BotRegistry` | List/get/add/update/remove, service token validation, S3 sync |
| `CommandLoader` | Load + render .md команд (кэш) |
| `LegionRouting` | Resolve — входной вебхук → команда |
| `WebhookPipeline` | Композиция: route → token → load → render → session → llm → reply |

---

## Уровень 3: In-process MCP (опционально)

Вместо subprocess — зарегистрировать MCP-сервера как in-process Effect-сервисы (через OpenCode MCP runtime). 

**Плюсы:**
- Прямой доступ к Effect-сервисам (логирование, конфиг, Http-клиент)
- Общие типы — BotConfig из BotRegistry, не ad-hoc JSON
- Нет subprocess overhead
- Event `mcp.tools.changed` при обновлении конфига бота

**Минусы:**
- Жёсткая связка с OpenCode
- MCP-сервера теряют независимость

Делать только если появится потребность в тесной интеграции (например, bot-factory должен сразу уведомлять OpenCode о новом боте).

---

## Уровень 4: Рефакторинг webhook.ts

Текущий `webhook.ts` (471 строка) — один `Effect.gen` с прямой работой с S3, fetch, файловой системой.

После уровней 1-2 превращается в:
```ts
const ingress = Effect.fn("Webhook.ingress")(function* (ctx) {
  const route  = yield* routing.resolve(...)
  const apiKey = yield* botReg.getApiKey(route.commandName)
  const cmd    = yield* cmds.load(route.commandsDir, route.commandName)
  const prompt = yield* cmds.render(cmd, ctx)
  const result = yield* sessionPrompt.prompt(...)
  yield* zulip.sendMessage({ botEmail: ..., botApiKey: apiKey, content: extractText(result) })
})
```

---

## Порядок имплементации

1. **Типы** в `packages/schema/src/legion/` — ZulipMessage, BotEntry, RoutingRule
2. **Q1** — кэш API-ключей  
3. **Q2** — `shared/parse-frontmatter.ts`  
4. **Ур.1** — `shared/mcp-transport.ts` + миграция серверов
5. **shared/**: bot-config.ts, routing.ts
6. **ZulipClient** (Effect)
7. **BotRegistry** + **CommandLoader** + **LegionRouting** (Effect)
8. **WebhookPipeline** — композиция
9. Замена `handlers/webhook.ts` на вызов pipeline
10. **Ур.3** — опционально, in-process MCP

---

## Status

- [ ] Q1 — кэш API-ключей
- [ ] Q2 — shared/parse-frontmatter.ts
- [ ] Ур.1 — mcp-transport.ts
- [ ] Ур.2 — shared-функции
- [ ] Ур.2 — Effect-сервисы
- [ ] Ур.2 — WebhookPipeline
- [ ] Ур.3 (опционально)
