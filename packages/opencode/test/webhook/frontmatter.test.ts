// Тесты парсера фронтматтера команд (.legion/command/*.md).
// Зачем: парсер определяет agent/model/mcp/allow/direct/ack для каждого запроса
// вебхука; ошибка тут тихо меняет модель, набор инструментов или политику
// доступа. Тесты фиксируют дефолты, разбор полного фронтматтера и краевые
// случаи (одиночный `---`, model без провайдера, трим тела).
import { describe, expect, test } from "bun:test"

import { parseFrontmatter } from "../../src/server/routes/instance/httpapi/handlers/webhook/frontmatter"

describe("parseFrontmatter", () => {
  test("текст без фронтматтера → дефолты, тело — тримленный весь текст", () => {
    const parsed = parseFrontmatter("\n  просто инструкция бота  \n")
    expect(parsed.agent).toBe("general")
    expect(parsed.mcp).toEqual({})
    expect(parsed.allow).toEqual([])
    expect(parsed.model).toBeUndefined()
    expect(parsed.direct).toBeUndefined()
    expect(parsed.directTimeout).toBeUndefined()
    expect(parsed.ack).toBeUndefined()
    expect(parsed.body).toBe("просто инструкция бота")
  })

  test("полный фронтматтер разбирает все поля", () => {
    const text = [
      "---",
      "agent: reviewer",
      "model: openai/gpt-5",
      'mcp: { files: true, shell: yes, web: false }',
      'allow: ["x@y.ru", "z"]',
      "direct: http://localhost:8088/ask",
      "direct_timeout: 5000",
      "ack: false",
      "---",
      "Ты ревьюер. Отвечай кратко.",
    ].join("\n")
    const parsed = parseFrontmatter(text)
    expect(parsed.agent).toBe("reviewer")
    expect(parsed.model).toBe("openai/gpt-5")
    expect(parsed.mcp).toEqual({ files: true, shell: true, web: false })
    expect(parsed.allow).toEqual(["x@y.ru", "z"])
    expect(parsed.direct).toBe("http://localhost:8088/ask")
    expect(parsed.directTimeout).toBe(5000)
    expect(parsed.ack).toBe(false)
    expect(parsed.body).toBe("Ты ревьюер. Отвечай кратко.")
  })

  test("ack: true разбирается как true, отсутствующий ack — undefined", () => {
    expect(parseFrontmatter("---\nack: true\n---\nтело").ack).toBe(true)
    expect(parseFrontmatter("---\nagent: x\n---\nтело").ack).toBeUndefined()
  })

  test("одиночный --- (parts.length < 3) → дефолты", () => {
    const parsed = parseFrontmatter("---\nagent: reviewer\nтело без закрывающего маркера")
    expect(parsed.agent).toBe("general")
    expect(parsed.mcp).toEqual({})
    expect(parsed.allow).toEqual([])
    expect(parsed.body).toBe("---\nagent: reviewer\nтело без закрывающего маркера")
  })

  test("model без слэша попадает в model как есть — валидация провайдера не здесь", () => {
    const parsed = parseFrontmatter("---\nmodel: gpt-5\n---\nтело")
    expect(parsed.model).toBe("gpt-5")
  })

  test("тело тримится и сохраняет внутренние --- как часть тела", () => {
    const parsed = parseFrontmatter("---\nagent: a\n---\n\n  строка один\n\n---\nвторая половина  \n\n")
    expect(parsed.body).toBe("строка один\n\n---\nвторая половина")
  })

  test("пустые allow/mcp-блоки → пустые значения, agent по умолчанию general", () => {
    const parsed = parseFrontmatter("---\nallow: []\nmcp: {}\n---\nтело")
    expect(parsed.allow).toEqual([])
    expect(parsed.mcp).toEqual({})
    expect(parsed.agent).toBe("general")
  })
})
