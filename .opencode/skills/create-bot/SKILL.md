---
name: create-bot
description: "Полный цикл создания бота Legion: спрашивает автора, название, промпт → создаёт .md команду → создаёт Zulip-бота → прописывает хук и API-ключ в конфиг → деплоит на сервер. Использовать когда нужно добавить нового бота в Legion."
---

# Create Bot — полный цикл

Используй этот скилл когда нужно создать нового бота для платформы Legion.

## Контекст

- Команды лежат в `.legion/command/<name>.md`
- Routing и API-ключи — в `.legion/integrations.jsonc`
- Сервер: `vdc-kvaz-n8n01`, порт 3000
- Zulip API: `listeners.2035.university`
- Webhook URL: `http://10.160.0.92:3000/webhook/zulip`
- Админ: `a.stepanov@2035.university` / `P7XOrwQQdvv0cOUBnP3avOeW5d18WEgk`

## Процесс

### 1. Спросить у пользователя

Запроси последовательно:

1. **Автор** — ФИО человека, который создаёт бота
2. **Email автора** — email в домене `@listeners.2035.university`
3. **Короткое имя бота** — латиница/цифры/дефисы, без пробелов. Используется как `short_name` в Zulip и как имя `.md` файла
4. **Полное имя бота** — отображаемое имя в Zulip
5. **Назначение бота** — 1-2 предложения, для чего бот
6. **Лабораторный канал** — Zulip-канал, где будет работать бот
7. **Текст промпта** — системный промпт бота

### 2. Создать файл команды

Путь: `.legion/command/<short_name>.md`

```markdown
---
name: <short_name>
description: "<назначение>"
agent: general
model: openai/gpt-4o
allow: ["<email>", "user8@listeners.2035.university", "user11@listeners.2035.university", "user602@listeners.2035.university"]
---

### <полное имя>

**Автор:** <автор>
**Назначение:** <назначение>
**Email:** <email>
**Канал:** <канал>

---

<текст промпта>
```

### 3. Создать Zulip-бота

```bash
curl -s -X POST "https://listeners.2035.university/api/v1/bots" \
  -u "a.stepanov@2035.university:P7XOrwQQdvv0cOUBnP3avOeW5d18WEgk" \
  -d "full_name=<полное имя>&short_name=<short_name>&bot_type=3"
```

Из ответа сохранить `user_id`, `api_key`, `email`.

Если ошибка "Email is already in use" — добавить суффикс `-v2` (или `-v3` и т.д.) к `short_name` и повторить. Сохранить итоговый `short_name`.

### 4. Проставить webhook URL

Важно: `service_payload_url` передавать JSON-кодированным (с кавычками).

```bash
curl -s -X PATCH "https://listeners.2035.university/api/v1/bots/<user_id>" \
  -u "a.stepanov@2035.university:P7XOrwQQdvv0cOUBnP3avOeW5d18WEgk" \
  -d 'service_payload_url="http://10.160.0.92:3000/webhook/zulip"&service_interface=1'
```

### 5. Обновить integrations.jsonc

Добавить в `bot_api_keys`:
```jsonc
"<email>": "<api_key>"
```

Добавить в `routing` ПЕРЕД правилом `"stream": "*"`:
```jsonc
{ "stream": "<short_name>", "command": "<short_name>" }
```

### 6. Деплой на сервер

```bash
rsync -avz /home/neo/Projects/legion_new/legion/.legion/command/<short_name>.md \
  vdc-kvaz-n8n01:/home/aestepanov/legion/.legion/command/<short_name>.md

rsync -avz /home/neo/Projects/legion_new/legion/.legion/integrations.jsonc \
  vdc-kvaz-n8n01:/home/aestepanov/legion/.legion/integrations.jsonc
```

### 7. Перезапустить сервер

```bash
ssh vdc-kvaz-n8n01 "lsof -ti:3000 | xargs kill -9 2>/dev/null; \
  sleep 1; cd /home/aestepanov/legion && \
  setsid ~/.bun/bin/bun run start-legion.ts </dev/null > /tmp/legion.log 2>&1 &"
```

### 8. Подтвердить

Сообщи пользователю:
- Имя бота
- Email бота
- API-ключ (для справки)
- Что бот добавлен в routing
- Что сервер перезапущен
