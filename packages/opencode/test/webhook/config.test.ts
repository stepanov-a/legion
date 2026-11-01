// Тесты конфиг-кэша вебхука: integrations.jsonc (JSONC: комментарии + висячие
// запятые) и кэш текстов команд .legion/command/*.md.
// Зачем: loadConfig/getCachedCommand читаются на каждый входящий вебхук, кэш
// держит их в памяти, а clearConfigCache() вызывается из /webhook/reload.
// Ошибка в кэше = команда не перечитывается после правки или, наоборот,
// читается с диска каждый раз. Тесты герметичны: LEGION_PROJECT_DIR — временный
// каталог, выставленный ДО импорта модуля (он читает env на уровне модуля).
import { afterAll, describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "legion-webhook-config-"))
process.env["LEGION_PROJECT_DIR"] = ROOT

const LEGION = path.join(ROOT, ".legion")
const INTEGRATIONS = path.join(LEGION, "integrations.jsonc")
const COMMANDS = path.join(LEGION, "command")
fs.mkdirSync(COMMANDS, { recursive: true })

// Свежий инстанс модуля на файл (?bust=...): bun test гоняет файлы в одном
// процессе, поэтому без этого env мог бы примениться после первого импорта.
type ConfigModule = typeof import("../../src/server/routes/instance/httpapi/handlers/webhook/config")
const CONFIG_SPEC = "../../src/server/routes/instance/httpapi/handlers/webhook/config.ts"
const loadConfigModule = async (tag: string): Promise<ConfigModule> =>
  (await import(`${CONFIG_SPEC}?bust=${tag}`)) as ConfigModule

fs.writeFileSync(
  INTEGRATIONS,
  `{
  // источник Zulip: события стримов и DM
  "default_command": "default",
  "sources": [
    {
      "name": "zulip",
      "commands_dir": ".legion/command",
      "routing": [
        { "field": "stream", "stream": "Поддержка", "command": "support" }, // висячая запятая ниже — валидна в JSONC
      ],
    },
  ],
}
`,
  "utf-8",
)

const config = await loadConfigModule("main")

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
})

describe("loadConfig", () => {
  test("читает .legion/integrations.jsonc из LEGION_PROJECT_DIR, понимает комментарии и висячие запятые", () => {
    expect(process.env["LEGION_PROJECT_DIR"]).toBe(ROOT)
    const parsed = config.loadConfig()
    expect(parsed.default_command).toBe("default")
    expect(parsed.sources).toHaveLength(1)
    expect(parsed.sources[0].name).toBe("zulip")
    expect(parsed.sources[0].routing[0]).toEqual({ field: "stream", stream: "Поддержка", command: "support" })
  })

  test("кэширует: после правки файла повторный вызов отдаёт старое значение", () => {
    config.clearConfigCache()
    expect(config.loadConfig().sources[0].name).toBe("zulip")
    fs.writeFileSync(INTEGRATIONS, `{ "sources": [{ "name": "edited" }] }`, "utf-8")
    expect(config.loadConfig().sources[0].name).toBe("zulip")
  })

  test("clearConfigCache сбрасывает кэш конфига — читается новая версия файла", () => {
    config.clearConfigCache()
    expect(config.loadConfig().sources[0].name).toBe("edited")
  })

  test("отсутствующий файл — исключение (кэш не подменяет ошибку)", () => {
    config.clearConfigCache()
    fs.rmSync(INTEGRATIONS, { force: true })
    expect(() => config.loadConfig()).toThrow()
    fs.writeFileSync(INTEGRATIONS, `{ "sources": [{ "name": "zulip" }] }`, "utf-8")
  })
})

describe("getCachedCommand", () => {
  test("читает .md команды и кэширует: подмена файла на диске не видна до сброса кэша", () => {
    config.clearConfigCache()
    const file = path.join(COMMANDS, "support.md")
    fs.writeFileSync(file, "---\nagent: general\n---\nверсия один", "utf-8")
    expect(config.getCachedCommand(COMMANDS, "support")).toContain("версия один")

    fs.writeFileSync(file, "---\nagent: general\n---\nверсия два", "utf-8")
    expect(config.getCachedCommand(COMMANDS, "support")).toContain("версия один")
  })

  test("clearConfigCache сбрасывает и кэш команд", () => {
    config.clearConfigCache()
    expect(config.getCachedCommand(COMMANDS, "support")).toContain("версия два")
  })

  test("нет файла → undefined, и это не кэшируется (после создания файл читается)", () => {
    config.clearConfigCache()
    expect(config.getCachedCommand(COMMANDS, "ghost")).toBeUndefined()
    fs.writeFileSync(path.join(COMMANDS, "ghost.md"), "тело призрака", "utf-8")
    expect(config.getCachedCommand(COMMANDS, "ghost")).toBe("тело призрака")
  })

  test("ключ кэша включает каталог: одинаковое имя в разных каталогах не смешивается", () => {
    config.clearConfigCache()
    const other = path.join(ROOT, "other-commands")
    fs.mkdirSync(other, { recursive: true })
    fs.writeFileSync(path.join(other, "support.md"), "другая команда", "utf-8")
    expect(config.getCachedCommand(COMMANDS, "support")).toContain("---")
    expect(config.getCachedCommand(other, "support")).toBe("другая команда")
  })
})
