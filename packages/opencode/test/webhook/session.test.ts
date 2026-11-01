// Тесты кэша сессий вебхука (ключ → sessionID, персист в .legion/session-cache.json).
// Зачем: от ключа зависит, продолжается ли диалог в той же сессии или каждая
// реплика открывает новую; сам кэш пишется на диск. Тесты должны быть
// герметичными: LEGION_PROJECT_DIR указывает во временный каталог ДО импорта
// модуля (он читает env на уровне модуля), иначе тест записал бы
// .legion/session-cache.json в реальный репозиторий.
import { afterAll, describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "legion-webhook-session-"))
process.env["LEGION_PROJECT_DIR"] = ROOT

// Свежий инстанс модуля на файл: ?bust=... не даёт bun переиспользовать
// закэшированный модуль другого тест-файла (bun test гоняет файлы в одном
// процессе), поэтому env точно применён.
type SessionModule = typeof import("../../src/server/routes/instance/httpapi/handlers/webhook/session")
const SESSION_SPEC = "../../src/server/routes/instance/httpapi/handlers/webhook/session.ts"
const loadSession = async (tag: string): Promise<SessionModule> =>
  (await import(`${SESSION_SPEC}?bust=${tag}`)) as SessionModule

const session = await loadSession("main")
const CACHE_FILE = path.join(ROOT, ".legion", "session-cache.json")

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
})

describe("sessionCacheKey", () => {
  test("детерминистичен: один и тот же набор аргументов — один и тот же ключ", () => {
    const a = session.sessionCacheKey("zulip", "поток", "тема", "u@d.ru", "cmd", "bot@d.ru")
    const b = session.sessionCacheKey("zulip", "поток", "тема", "u@d.ru", "cmd", "bot@d.ru")
    expect(a).toBe(b)
  })

  test("ветка stream: ключ зависит от source/stream/topic/commandName", () => {
    const base = session.sessionCacheKey("zulip", "поток", "тема", "u@d.ru", "cmd", "bot@d.ru")
    expect(base).toBe("zulip:поток:тема:cmd")
    expect(session.sessionCacheKey("other", "поток", "тема", "u@d.ru", "cmd", "bot@d.ru")).not.toBe(base)
    expect(session.sessionCacheKey("zulip", "другой", "тема", "u@d.ru", "cmd", "bot@d.ru")).not.toBe(base)
    expect(session.sessionCacheKey("zulip", "поток", "другая", "u@d.ru", "cmd", "bot@d.ru")).not.toBe(base)
    expect(session.sessionCacheKey("zulip", "поток", "тема", "u@d.ru", "other", "bot@d.ru")).not.toBe(base)
  })

  test("ветка stream намеренно не учитывает sender и botEmail (одна сессия на тему)", () => {
    const base = session.sessionCacheKey("zulip", "поток", "тема", "u@d.ru", "cmd", "bot@d.ru")
    expect(session.sessionCacheKey("zulip", "поток", "тема", "someone@else.ru", "cmd", "bot@d.ru")).toBe(base)
    expect(session.sessionCacheKey("zulip", "поток", "тема", "u@d.ru", "cmd", "other-bot@d.ru")).toBe(base)
  })

  test("ветка dm: ключ зависит от source/sender/botEmail/commandName", () => {
    const base = session.sessionCacheKey("zulip", "dm", "тема", "u@d.ru", "cmd", "bot@d.ru")
    expect(base).toBe("zulip:dm:u@d.ru:bot@d.ru:cmd")
    expect(session.sessionCacheKey("other", "dm", "тема", "u@d.ru", "cmd", "bot@d.ru")).not.toBe(base)
    expect(session.sessionCacheKey("zulip", "dm", "тема", "v@d.ru", "cmd", "bot@d.ru")).not.toBe(base)
    expect(session.sessionCacheKey("zulip", "dm", "тема", "u@d.ru", "cmd", "bot2@d.ru")).not.toBe(base)
    expect(session.sessionCacheKey("zulip", "dm", "тема", "u@d.ru", "other", "bot@d.ru")).not.toBe(base)
  })

  test("ветка dm: topic не влияет, а botEmail по умолчанию — 'default'", () => {
    const base = session.sessionCacheKey("zulip", "dm", "тема", "u@d.ru", "cmd")
    expect(session.sessionCacheKey("zulip", "dm", "другая тема", "u@d.ru", "cmd")).toBe(base)
    expect(base).toBe("zulip:dm:u@d.ru:default:cmd")
  })
})

describe("getOrCreateSessionID", () => {
  test("один ключ → один и тот же id, разные ключи → разные id", () => {
    session.clearSessionCache()
    const a1 = session.getOrCreateSessionID("zulip:поток:тема:cmd")
    const a2 = session.getOrCreateSessionID("zulip:поток:тема:cmd")
    const b = session.getOrCreateSessionID("zulip:поток:другая:cmd")
    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
    expect(a1.startsWith("ses_wh_")).toBe(true)
  })

  test("пишет кэш в LEGION_PROJECT_DIR из env, а не в cwd", () => {
    session.clearSessionCache()
    session.getOrCreateSessionID("hermetic-check")
    expect(process.env["LEGION_PROJECT_DIR"]).toBe(ROOT)
    expect(fs.existsSync(CACHE_FILE)).toBe(true)
    const onDisk = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"))
    expect(Object.keys(onDisk)).toContain("hermetic-check")
  })

  test("кэш читается с диска: свежий инстанс модуля отдаёт тот же id", async () => {
    session.clearSessionCache()
    const id = session.getOrCreateSessionID("persisted-key")
    const reloaded = await loadSession("reload")
    expect(reloaded.getOrCreateSessionID("persisted-key")).toBe(id)
  })
})

describe("clearSessionCache", () => {
  test("возвращает число очищенных записей и обнуляет кэш", () => {
    session.clearSessionCache()
    session.getOrCreateSessionID("k1")
    session.getOrCreateSessionID("k2")
    expect(session.clearSessionCache()).toBe(2)
    expect(session.clearSessionCache()).toBe(0)
    expect(JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"))).toEqual({})
  })

  test("после очистки id для ключа восстанавливается детерминированно (md5 ключа)", () => {
    session.clearSessionCache()
    const first = session.getOrCreateSessionID("stable-key")
    session.clearSessionCache()
    const second = session.getOrCreateSessionID("stable-key")
    expect(second).toBe(first)
  })
})
