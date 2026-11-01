# `.opencode/opencode.jsonc` — конфиг рантайма

Конфиг версионируется и **секретов в нём нет**. Ключи подставляются из окружения
загрузчиком конфига (`packages/opencode/src/config/variable.ts`,
`ConfigVariable.substitute`): поддерживаются ровно две формы — `{env:NAME}` и
`{file:path}`.

## Обязательные переменные окружения

| Переменная | Где используется | Значение |
|---|---|---|
| `DEEPSEEK_API_KEY` | `provider.deepseek.options.apiKey` | ключ DeepSeek (OpenCode Zen) |
| `NTI_API_KEY` | `provider.nti.options.apiKey` | ключ NTI API |

Без них соответствующая строка подставится пустой, и провайдер не авторизуется.
Задаются в окружении процесса `opencode` (или в `.env`, подхватываемом
compose-сервисом `legion`).

## Что внутри

- 13 MCP-серверов (локальные, `bun run /legion/.legion/mcp-*/index.ts`);
- 2 провайдера: `deepseek`, `nti`;
- `permission`, `references`, `tools` — как в живом рантайме.

Живая копия с реальными ключами в репозиторий не кладётся: правьте этот файл
и держите значения ключей только в окружении.
