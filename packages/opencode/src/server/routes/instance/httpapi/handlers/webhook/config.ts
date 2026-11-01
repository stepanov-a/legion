import * as path from "path"
import * as fs from "fs"
import { parse as parseJsonc } from "jsonc-parser"

const PROJECT_ROOT = process.env.LEGION_PROJECT_DIR ?? process.cwd()
const LEGION_DIR = path.join(PROJECT_ROOT, ".legion")
const ROUTING_PATH = path.join(LEGION_DIR, "integrations.jsonc")

let cachedConfig: any = null
const cachedCommands = new Map<string, string>()

export function loadConfig(): any {
  if (cachedConfig) return cachedConfig
  cachedConfig = parseJsonc(fs.readFileSync(ROUTING_PATH, "utf-8"))
  return cachedConfig
}

export function getCachedCommand(dir: string, name: string): string | undefined {
  const key = `${dir}:${name}`
  const existing = cachedCommands.get(key)
  if (existing !== undefined) return existing
  try {
    const text = fs.readFileSync(path.join(dir, `${name}.md`), "utf-8")
    cachedCommands.set(key, text)
    return text
  } catch {
    return undefined
  }
}

export function clearConfigCache(): void {
  cachedConfig = null
  cachedCommands.clear()
}
