// Тесты allow-матчера: проверка доступа из фронтматтера команды.
// Зачем: логика была inline в handler.ts и не тестировалась вообще, хотя решает,
// кого пускают к команде. Тесты фиксируют фактическое поведение (регистро-
// независимое сравнение, wildcard-суффикс и wildcard-префикс), чтобы будущие
// правки не открыли доступ молча.
import { describe, expect, test } from "bun:test"

import { matchesAllow } from "../../src/server/routes/instance/httpapi/handlers/webhook/allow"

describe("matchesAllow", () => {
  test("пустой allow-список пропускает никого (решение «без ограничений» — в handler)", () => {
    expect(matchesAllow([], "user@dom.tld")).toBe(false)
  })

  test("точное совпадение e-mail", () => {
    expect(matchesAllow(["user@dom.tld"], "user@dom.tld")).toBe(true)
    expect(matchesAllow(["user@dom.tld"], "other@dom.tld")).toBe(false)
    expect(matchesAllow(["user@dom.tld"], "user@dom.tl")).toBe(false)
    expect(matchesAllow(["user@dom.tld"], "user@dom.tldx")).toBe(false)
  })

  test("сравнение регистронезависимое (обе стороны приводятся к нижнему регистру)", () => {
    expect(matchesAllow(["User@Dom.TLD"], "user@dom.tld")).toBe(true)
    expect(matchesAllow(["user@dom.tld"], "USER@DOM.TLD")).toBe(true)
    expect(matchesAllow(["*@DOM.tld"], "anyone@dom.tld")).toBe(true)
  })

  test("wildcard-суффикс user@dom* ловит поддомены/зоны этого пользователя и не ловит другого", () => {
    expect(matchesAllow(["user@dom*"], "user@domain.tld")).toBe(true)
    expect(matchesAllow(["user@dom*"], "user@dom.tld")).toBe(true)
    expect(matchesAllow(["user@dom*"], "another@domain.tld")).toBe(false)
    expect(matchesAllow(["user@dom*"], "user@other-tld")).toBe(false)
  })

  test("wildcard-префикс *@dom.tld ловит любого на домене и не ловит другой домен", () => {
    expect(matchesAllow(["*@dom.tld"], "anyone@dom.tld")).toBe(true)
    expect(matchesAllow(["*@dom.tld"], "a.b@dom.tld")).toBe(true)
    expect(matchesAllow(["*@dom.tld"], "anyone@sub.dom.tld")).toBe(false)
    expect(matchesAllow(["*@dom.tld"], "anyone@other.tld")).toBe(false)
    expect(matchesAllow(["*@dom.tld"], "anyone@dom.tld.evil")).toBe(false)
  })

  test("достаточно одного совпадения из списка", () => {
    const allow = ["boss@corp.ru", "*@partner.ru", "user@dom*"]
    expect(matchesAllow(allow, "boss@corp.ru")).toBe(true)
    expect(matchesAllow(allow, "any@partner.ru")).toBe(true)
    expect(matchesAllow(allow, "user@domain.io")).toBe(true)
    expect(matchesAllow(allow, "stranger@else.ru")).toBe(false)
  })

  test("пустой e-mail не проходит непустой allow-список", () => {
    expect(matchesAllow(["user@dom.tld"], "")).toBe(false)
    expect(matchesAllow(["*"], "")).toBe(true)
  })

  test("голый wildcard * пропускает всех (в т.ч. пустой e-mail, т.к. endsWith(''))", () => {
    expect(matchesAllow(["*"], "anyone@anywhere.tld")).toBe(true)
  })
})
