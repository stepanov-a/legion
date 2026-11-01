import * as path from "path"
import * as crypto from "crypto"
import * as fs from "fs"
import { SessionV2 } from "@opencode-ai/core/session"

const PROJECT_ROOT = process.env.LEGION_PROJECT_DIR ?? process.cwd()
const LEGION_DIR = path.join(PROJECT_ROOT, ".legion")
const SESSION_CACHE_PATH = path.join(LEGION_DIR, "session-cache.json")

const sessionCache = new Map<string, string>()

function loadSessionCache(): void {
  try {
    const raw = fs.readFileSync(SESSION_CACHE_PATH, "utf-8")
    const data = JSON.parse(raw)
    for (const [k, v] of Object.entries(data)) sessionCache.set(k, v as string)
  } catch {}
}
loadSessionCache()

function saveSessionCache(): void {
  try {
    const obj = Object.fromEntries(sessionCache)
    fs.mkdirSync(path.dirname(SESSION_CACHE_PATH), { recursive: true })
    fs.writeFileSync(SESSION_CACHE_PATH, JSON.stringify(obj), "utf-8")
  } catch {}
}

export function sessionCacheKey(source: string, stream: string, topic: string, sender: string, commandName: string, botEmail?: string): string {
  if (stream === "dm") return `${source}:dm:${sender}:${botEmail ?? "default"}:${commandName}`
  return `${source}:${stream}:${topic}:${commandName}`
}

export function getOrCreateSessionID(key: string): string {
  const existing = sessionCache.get(key)
  if (existing) return existing
  const hash = crypto.createHash("md5").update(key).digest("hex").slice(0, 16)
  const id = SessionV2.ID.descending("ses_wh_" + hash)
  sessionCache.set(key, id as string)
  saveSessionCache()
  return id as string
}

export function clearSessionCache(): number {
  const count = sessionCache.size
  sessionCache.clear()
  saveSessionCache()
  return count
}
