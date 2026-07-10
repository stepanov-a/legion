# Pipeline Execution (RAGFlow → LLM-Wiki → Cards)

## Tools

### `export_wiki`
Экспортирует все чанки из RAGFlow в markdown-файлы (один файл на документ) в `.legion/pipeline-execution/wiki/`.

Файлы содержат frontmatter с метаданными и содержимое чанков. Без лишней обработки — чистый экспорт.

### `build_cards`
Строит карточки сущностей:

1. **Phase 1** — LLM анализирует выборку чанков по каждому датасету и выделяет ключевые сущности
2. **Phase 2** — поиск всех чанков, упоминающих каждую сущность
3. **Phase 3** — LLM генерирует карточку: определение, факты, связанные сущности

### Формат карточек
Карточки сохраняются в `.legion/pipeline-execution/cards/` в markdown:

```markdown
# Card: Cognitive Warfare

ОПРЕДЕЛЕНИЕ: Когнитивная война — это шестая область военных операций...

ФАКТЫ:
- ...
- ...

СВЯЗАНО:
- [[Information Warfare]]
- [[Drone-Centric Concept]]

---
**Источники**:
- CW_T1.pdf (НТИ. Семинар Глобальный мир 2035)
- CW_T5.pdf (НТИ. Семинар Глобальный мир 2035)
```

### Obsidian-граф
Связанные сущности в карточках форматируются как `[[EntityName]]` для совместимости с Obsidian. При открытии папок `wiki/` и `cards/` как Obsidian-хранилища, граф связей строится автоматически.

### LLM-провайдер
Настраивается в `legion.jsonc` → `environment`:
- `LLM_PROVIDER`: `ollama`, `openai`, `openai-compatible`
- `LLM_BASE_URL`: базовый URL API
- `LLM_MODEL`: имя модели
- `LLM_API_KEY`: ключ (если нужен)
