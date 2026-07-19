# MCP — бэклог разработки

**Дата:** 19 июля 2026
**Контекст:** Legion (форк OpenCode) + Архипелаг 2026

---

## P0 — без этого ничего не работает

### ☐ mcp-ragflow — Документы (parse), RAG и семантический поиск

**Мотивация:** RagFlow уже развёрнут. Парсит PDF, DOCX, PPTX, XLSX, CSV, TXT, MD нативно — chunking, извлечение текста и таблиц. Отдельный парсер не нужен.

**Готово:** RagFlow API, MCP-адаптер существует (упомянут в arch.md).
**Сделать:** донастроить, задокументировать интерфейс.

**Инструменты:**
- `upload_document(file_url, kb_id)` → chunk_count
- `search_knowledge_base(query, kb_id)` → chunks + sources
- `extract_text(file_url)` → текст
- `extract_tables(file_url)` → таблицы
- `create_knowledge_base(name, description)` → kb_id

**RagFlow НЕ делает:** создание документов/презентаций/таблиц — это ниже (S2–S4).

---

### ☐ mcp-s3-storage — Файловое хранилище

**Мотивация:** S3 (MinIO) уже развёрнут. Legion и все боты должны читать/писать данные. Без MCP-обёртки каждый бот пишет свой S3-клиент.

**Готово:** s3fs-mcp (GitHub: lunai408/s3fs-mcp) — поддерживает MinIO.
**Сделать:** настроить endpoint, bucket, access/secret key, workspace isolation на лабораторию.

**Инструменты:**
- `read_file(path)` → content
- `write_file(path, content)` → confirmation
- `list_files(prefix)` → file list
- `move_file(source, target)` → confirmation
- `delete_file(path)` → confirmation
- `get_share_link(path, expiry)` → ссылка

---

## P1 — масштабирование под 15 лабораторий

### ☐ mcp-zulip — Управление чатами

**Мотивация:** Сейчас Legion только отвечает в чат. Боты не могут создать канал, пригласить участника, искать по истории. Для 15 лабораторий нужно управление чатами программно.

**Готово:** Zulip API. Нужна обёртка в MCP.
**Сделать:** написать MCP-сервер, настроить admin-токен.

**Инструменты:**
- `send_message(stream, topic, content)` → msg_id
- `create_stream(name, description)` → confirmation
- `invite_users(stream, user_emails)` → confirmation
- `search_messages(query, stream)` → messages
- `create_topic(stream, topic)` → confirmation

---

## P2 — артефакты и усиление (к финалу, не к старту)

### ☐ mcp-tables — Таблицы (XLSX/CSV)

**Мотивация:** Лаборатории работают с реестрами, планами, скоринговыми таблицами. Боты должны уметь их создавать и редактировать. Google исключён.

**Реализация:** openpyxl (Python). Хранение в S3.
**Сделать:** написать MCP-сервер, завести шаблоны.

**Инструменты:**
- `read_table(file_url, range)` → данные + метаданные
- `write_table(data, structure)` → file_url
- `find_errors(file_url)` → список ошибок
- `transform_table(file_url, operations)` → file_url
- `create_from_template(template_id, data)` → file_url

---

### ☐ mcp-presentations — Презентации (PPTX)

**Мотивация:** Результат лаборатории — презентация. Бот должен уметь её собрать, а не выдать текст. Google исключён.

**Реализация:** python-pptx. Конвертация в PDF через LibreOffice headless. Хранение в S3.
**Сделать:** написать MCP-сервер, завести шаблоны.

**Инструменты:**
- `analyze_presentation(file_url)` → list правок + структура
- `create_presentation(spec)` → file_url
- `update_slide(presentation_url, slide_number, content)` → file_url
- `create_from_template(template_id, data)` → file_url
- `convert_to_pdf(file_url)` → pdf_url

---

### ☐ mcp-media — Изображения, аудио, видео

**Мотивация:** Хрустальный шар производит аудио — боты должны уметь его анализировать. Нужна генерация картинок и базовый анализ медиа.

**Реализация:** ffmpeg + whisper (готов) + Replicate/SD для генерации.
**Сделать:** написать MCP-сервер, подключить к whisper и Replicate.

**Инструменты:**
- `transcribe_audio(file_url)` → text
- `summarize_audio(file_url)` → bullet points
- `generate_image(prompt, spec)` → file_url
- `analyze_image(file_url)` → описание
- `extract_metadata(file_url)` → метаданные

---

### ☐ mcp-bot-factory — Фабрика ботов

**Мотивация:** Пользователь описывает навык — система создаёт бота сама. Ключевое масштабирующее свойство Архипелага.

**Готовых решений нет.** Только кастомная разработка. Самый сложный сервер.

**Зависимости:** Zulip API, Legion API, S3, RagFlow, LLM.

**Инструменты:**
- `receive_manifest(skill_manifest)` → bot_draft
- `generate_system_prompt(bot_draft)` → prompt_text
- `create_zulip_bot(prompt_text, name)` → bot_email, api_key
- `configure_mcp_access(bot_name, allowed_servers)` → config
- `attach_knowledge_base(bot_name, sources)` → confirmation
- `run_test_scenario(bot_name, test_prompt)` → result + score

---

## P3 — observability

### ☐ mcp-langfuse — LLM трейсинг

**Мотивация:** 34+ бота × N запросов — без трейсинга непонятно, что работает. LangFuse уже развёрнут.

**Реализация:** LangFuse SDK. Можно встроить напрямую в Legion, отдельный MCP-сервер опционален.

---

## Схема подключения

```
Zulip (чат) → Legion (ядро) → MCP-сервера
                                  ├── mcp-ragflow (RagFlow API)
                                  ├── mcp-tables (openpyxl + S3)
                                  ├── mcp-presentations (python-pptx + LibreOffice + S3)
                                  ├── mcp-media (ffmpeg + whisper + Replicate)
                                  ├── mcp-s3-storage (s3fs → MinIO)
                                  ├── mcp-bot-factory (кастомный)
                                  ├── mcp-zulip (Zulip API)
                                  └── mcp-langfuse (LangFuse SDK)
```

Каждый MCP-сервер — независимый контейнер. Регистрация в Legion — конфигурационный файл.

---

## Технические требования ко всем

- Транспорт: HTTP (SSE)
- Аутентификация: API-ключ
- Ошибки: JSON-RPC 2.0
- Логи: stdout контейнера
- Метрики: Prometheus /metrics (latency p50/p95/p99, errors)
- Документация: README.md + curl-примеры
- Конфигурация: переменные окружения
