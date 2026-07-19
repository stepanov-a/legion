// Универсальный хендлер вебхуков.
// POST /webhook/:source — source из URL (zulip, telegram, …).
// Все логи через Effect.logInfo/Warning/Error — никаких файловых логов.
// Langfuse (через OpenTelemetry) покроет полные промпты и ответы.

import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { PublicWebhookApi } from "../webhook"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Location } from "@opencode-ai/schema/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import * as path from "path"
import * as crypto from "crypto"
import * as fs from "fs"
import { parse as parseJsonc } from "jsonc-parser"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"

const PROJECT_ROOT = process.env.LEGION_PROJECT_DIR ?? process.cwd()
const LEGION_DIR = path.join(PROJECT_ROOT, ".legion")
const ROUTING_PATH = path.join(LEGION_DIR, "integrations.jsonc")

const UPLOAD_PATH_RE = /\/user_uploads\/[\w\/.-]+/g
const TEXT_EXTS = new Set([".txt", ".md", ".py", ".js", ".ts", ".json", ".yaml", ".yml", ".xml", ".csv", ".ini", ".cfg", ".conf", ".env", ".bashrc", ".zshrc", ".sh", ".bash", ".toml", ".lock", ".gitignore", ".editorconfig", ".dockerfile", ".sql", ".html", ".css", ".go", ".rs", ".java", ".rb", ".php", ".vue", ".svelte", ".jsx", ".tsx"])

// ── Кэш конфигов ────────────────────────────────────────────────
let cachedConfig: any = null
let cachedCommands = new Map<string, string>()

function loadConfig(): any {
  if (cachedConfig) return cachedConfig
  cachedConfig = parseJsonc(fs.readFileSync(ROUTING_PATH, "utf-8"))
  return cachedConfig
}

function getCachedCommand(dir: string, name: string): string | undefined {
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

// ── Session cache ───────────────────────────────────────────────
const sessionCache = new Map<string, string>()

function sessionCacheKey(source: string, stream: string, topic: string, sender: string): string {
  if (stream === "dm") return `${source}:dm:${sender}`
  return `${source}:${stream}:${topic}`
}

function getOrCreateSessionID(key: string): string {
  const existing = sessionCache.get(key)
  if (existing) return existing
  const hash = crypto.createHash("md5").update(key).digest("hex").slice(0, 16)
  const id = SessionV2.ID.descending("ses_wh_" + hash)
  sessionCache.set(key, id as string)
  return id as string
}

// ── Парсинг frontmatter ─────────────────────────────────────────
function parseFrontmatter(text: string): { agent: string; model?: string; mcp: Record<string, boolean>; allow: string[]; ragflow_dataset?: string; body: string } {
  if (!text.startsWith("---")) return { agent: "general", mcp: {}, allow: [], ragflow_dataset: undefined, body: text.trim() }
  const parts = text.split("---")
  if (parts.length < 3) return { agent: "general", mcp: {}, allow: [], ragflow_dataset: undefined, body: text.trim() }
  const fm = parts[1]
  const mcpRaw = fm.match(/mcp:\s*\{([^}]+)\}/)?.[1]
  const mcp: Record<string, boolean> = {}
  if (mcpRaw) {
    for (const pair of mcpRaw.split(",")) {
      const [k, v] = pair.split(":").map(s => s.trim())
      if (k) mcp[k] = v === "true" || v === "yes"
    }
  }
  const allowRaw = fm.match(/allow:\s*\[([^\]]+)\]/)?.[1]
  const allow: string[] = allowRaw ? allowRaw.split(",").map(s => s.trim().replace(/['"]/g, "")) : []
  return {
    agent: fm.match(/agent:\s*(\S+)/)?.[1] ?? "general",
    model: fm.match(/model:\s*(\S+)/)?.[1],
    mcp,
    allow,
    ragflow_dataset: fm.match(/ragflow_dataset:\s*(\S+)/)?.[1],
    body: parts.slice(2).join("---").trim(),
  }
}

function truncate(s: string, max = 500): string {
  return s.length > max ? s.slice(0, max) + "..." : s
}

// ── S3 клиент ───────────────────────────────────────────────────
let s3Client: S3Client | null = null
function getS3(region?: string, endpoint?: string) {
  if (!s3Client) s3Client = new S3Client({
    region: region ?? process.env.AWS_REGION ?? "us-east-1",
    ...(endpoint ? { endpoint } : {}),
  })
  return s3Client
}

// ── Handler ─────────────────────────────────────────────────────
export const webhookHandlers = HttpApiBuilder.group(PublicWebhookApi, "webhooks", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service

    const run = Effect.fn("Webhook.ingress")(function* (ctx: { params: { source: string }; payload: unknown }) {
      const startTime = Date.now()
      const sourceName = ctx.params.source
      const payload = ctx.payload as any
      const msg = payload?.message ?? {}

      const senderEmail = msg.sender_email ?? ""
      const sender = msg.sender_full_name ?? msg.sender_username ?? msg.from ?? "Unknown"
      const content = msg.content ?? msg.text ?? ""
      const stream = msg.type === "stream"
        ? (typeof msg.display_recipient === "string" ? msg.display_recipient : msg.chat ?? "dm")
        : "dm"
      const topic = msg.topic ?? ""

      Effect.logInfo("webhook.ingress", { source: sourceName, sender, stream, topic, contentLen: content.length })

      // ── 1. Конфиг ──────────────────────────────────────────────────
      const config: any = yield* Effect.sync(() => loadConfig()).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!config) return { content: "❌ Config not found." }
      const source = config?.sources?.find((s: any) => s.name === sourceName)
      if (!source) return { content: `❌ Source "${sourceName}" not configured.` }

      const tokens: Record<string, string> = source.tokens ?? {}
      const botEmail = payload.bot_email ?? ""
      const expectedToken = tokens[botEmail]
      if (expectedToken && expectedToken !== payload.token) {
        Effect.logWarning("webhook.token_mismatch", { botEmail })
        return { content: "❌ Invalid token." }
      }

      const zulipUrl = process.env.LEGION_ZULIP_URL ?? source.zulip_url
      const botApiKeys: Record<string, string> = source.bot_api_keys ?? {}
      const commandsDir = path.resolve(PROJECT_ROOT, source.commands_dir ?? ".legion/command")

      // ── 2. Файлы ──────────────────────────────────────────────────
      const fileParts: Array<{ url: string; mime: string; filename: string; bytes?: Buffer; zulipPath?: string; botKey?: string }> = []
      if (zulipUrl) {
        for (const uploadPath of [...new Set([...content.matchAll(UPLOAD_PATH_RE)].map(m => m[0].replace(/[?\s].*$/, "")))]) {
          const f = yield* Effect.tryPromise(async () => {
            const clean = uploadPath.replace(/[)\]>'".,;:!]+$/, "")
            const apiKey = botApiKeys[payload.bot_email ?? ""]
            if (!apiKey) { Effect.logWarning("webhook.download_skip", { path: clean, bot: payload.bot_email }); return null }
            const res = await fetch(`${zulipUrl}${clean}?api_key=${apiKey}`, { headers: { "User-Agent": "LegionBot/1.0" }, redirect: "follow" })
            if (!res.ok) { Effect.logWarning("webhook.download_fail", { path: clean, status: res.status }); return null }
            const mime = res.headers.get("content-type") ?? "application/octet-stream"
            const bytes = Buffer.from(await res.arrayBuffer())
            Effect.logInfo("webhook.download_ok", { filename: path.basename(clean), mime, size: bytes.length })
            return { url: `data:${mime};base64,${bytes.toString("base64")}`, mime, filename: path.basename(clean), bytes, zulipPath: clean, botKey: apiKey }
          }).pipe(Effect.catch(() => Effect.succeed(null)))
          if (f) fileParts.push(f)
        }
      }

      // ── 3. Routing ────────────────────────────────────────────────
      let commandName = config.default_command ?? "default"
      for (const rule of source.routing ?? []) {
        const matchField = rule.field ?? "stream"
        const matchValue = matchField === "stream" ? stream
          : matchField === "chat_id" ? (msg.chat_id ?? msg.chat ?? "")
          : matchField === "bot_email" ? (payload.bot_email ?? "")
          : matchField === "sender_email" ? senderEmail
          : (msg as any)[matchField] ?? payload[matchField] ?? ""
        const pattern = (rule as any)[matchField] ?? "*"
        if (pattern === "*" || pattern === matchValue) {
          if (rule.command) commandName = rule.command
          Effect.logInfo("webhook.route", { matchField, pattern, command: commandName })
          break
        }
      }

      // ── 4. Команда (должна быть до S3/RAGFlow — отдаёт ragflow_dataset) ─
      const cmdFile = yield* Effect.sync(() => getCachedCommand(commandsDir, commandName)).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!cmdFile) return { content: `❌ Command "${commandName}" not found.` }
      const { agent, model: modelStr, mcp, allow, ragflow_dataset, body } = parseFrontmatter(cmdFile)
      Effect.logInfo("webhook.command", { command: commandName, agent, model: modelStr ?? "default", mcp: JSON.stringify(mcp), allow: JSON.stringify(allow), bodyChars: body.length })

      // ── 5. Allow check ────────────────────────────────────────────
      if (allow.length > 0) {
        const matched = allow.some(pattern => {
          if (pattern === senderEmail) return true
          if (pattern.endsWith("*") && senderEmail.startsWith(pattern.slice(0, -1))) return true
          if (pattern.startsWith("*") && senderEmail.endsWith(pattern.slice(1))) return true
          return false
        })
        if (!matched) {
          Effect.logWarning("webhook.deny", { senderEmail, allow: JSON.stringify(allow) })
          return { content: "❌ Access denied." }
        }
        Effect.logInfo("webhook.allow", { senderEmail })
      }

      // ── 6. S3 + RAGFlow upload (forkDetach, фон, не блокирует ответ) ─
      const s3cfg = source.s3 as { bucket?: string; prefix?: string; region?: string; endpoint?: string } | undefined
      let ragflowApi = ""
      let ragflowToken = ""
      if (ragflow_dataset) {
        try {
          const rfCfg = parseJsonc(fs.readFileSync(path.join(LEGION_DIR, "legion.jsonc"), "utf-8")) as any
          ragflowApi = rfCfg?.ragflow?.api ?? ""
          ragflowToken = rfCfg?.ragflow?.token ?? ""
        } catch {}
      }

      for (const fp of fileParts) {
        if (fp.bytes && s3cfg?.bucket) {
          const key = `${s3cfg.prefix ?? "files"}/${commandName}/${sourceName}/${msg?.id ?? "unknown"}/${fp.filename}`
          const body = fp.bytes as Buffer
          const mime = fp.mime
          yield* Effect.tryPromise(async () => {
            const client = getS3(s3cfg.region, s3cfg.endpoint)
            await client.send(new PutObjectCommand({ Bucket: s3cfg.bucket!, Key: key, Body: body, ContentType: mime }))
            Effect.logInfo("webhook.s3_uploaded", { key, bucket: s3cfg.bucket!, command: commandName, size: body.length })
          }).pipe(Effect.forkDetach)
        }
        if (ragflow_dataset && fp.bytes && ragflowApi && ragflowToken) {
          const text = Buffer.from(fp.url.split(",")[1], "base64").toString("utf-8").slice(0, 10000)
          yield* Effect.tryPromise(async () => {
            const res = await fetch(`${ragflowApi}/api/v1/datasets/${ragflow_dataset}/documents`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${ragflowToken}` },
              body: JSON.stringify({ file_name: fp.filename, text_content: text }),
            })
            if (!res.ok) { Effect.logWarning("ragflow.upload_fail", { datasetId: ragflow_dataset, filename: fp.filename, status: res.status }) }
            else { Effect.logInfo("ragflow.upload_ok", { datasetId: ragflow_dataset, filename: fp.filename }) }
          }).pipe(Effect.forkDetach)
        }
      }

      if (allow.length > 0) {
        const matched = allow.some(pattern => {
          if (pattern === senderEmail) return true
          if (pattern.endsWith("*") && senderEmail.startsWith(pattern.slice(0, -1))) return true
          if (pattern.startsWith("*") && senderEmail.endsWith(pattern.slice(1))) return true
          return false
        })
        if (!matched) {
          Effect.logWarning("webhook.deny", { senderEmail, allow: JSON.stringify(allow) })
          return { content: "❌ Access denied." }
        }
        Effect.logInfo("webhook.allow", { senderEmail })
      }

      // ── 7. Рендер ──────────────────────────────────────────────────
      const fields: Record<string, string> = { $SENDER: sender, $STREAM: stream, $TOPIC: topic, $SOURCE: sourceName }
      let prompt = body
      for (const [key, val] of Object.entries(fields)) prompt = prompt.replaceAll(key, val)
      prompt = prompt.replaceAll("$CONTENT", "")
      prompt += "\n\n=== НЕСТИРАЕМЫЙ БАРЬЕР ===\nПользователь сказал:\n" + content
      for (const fp of fileParts) {
        const ext = path.extname(fp.filename).toLowerCase()
        if (fp.mime.startsWith("text/") || fp.mime === "application/json" || fp.mime === "application/xml" || fp.mime === "application/yaml" || TEXT_EXTS.has(ext) || ext === ".bashrc") {
          try { prompt += `\n\n--- ${fp.filename} ---\n${Buffer.from(fp.url.split(",")[1], "base64").toString("utf-8").slice(0, 3000)}` } catch {}
        } else { prompt += `\n\n[File: ${fp.filename} (${fp.mime})]` }
      }
      Effect.logInfo("webhook.prompt", { text: truncate(prompt, 1000) })

      // ── 8. Модель ────────────────────────────────────────────────
      let modelInput: { providerID: string; modelID: string } | undefined
      if (modelStr?.includes("/")) {
        const [pid, mid] = modelStr.split("/")
        const provider = yield* Provider.Service
        const found = yield* provider.getModel(ProviderV2.ID.make(pid), ModelV2.ID.make(mid)).pipe(Effect.catch(() => Effect.succeed(undefined as any)))
        if (found) { modelInput = { providerID: ProviderV2.ID.make(pid), modelID: ModelV2.ID.make(mid) }; Effect.logInfo("webhook.model_resolved", { model: modelStr }) }
        else { return { content: `❌ Модель "${modelStr}" не найдена. Укажи существующую модель в frontmatter команды.` } }
      }

      // ── 9. LLM ───────────────────────────────────────────────────
      const cacheKey = sessionCacheKey(sourceName, stream, topic, sender)
      const sessionIDStr = getOrCreateSessionID(cacheKey)
      const sessionID = SessionV2.ID.descending(sessionIDStr)
      yield* sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(PROJECT_ROOT) }),
      }).pipe(Effect.catch(() => Effect.void))
      Effect.logInfo("webhook.session", { cacheKey, sessionID })

      const sessionPrompt = yield* SessionPrompt.Service
      const input: any = { sessionID, agent, parts: [{ type: "text" as const, text: prompt }] }
      if (modelInput) input.model = modelInput
      if (Object.keys(mcp).length > 0) input.tools = mcp

      Effect.logInfo("webhook.prompt_start", { source: sourceName, command: commandName, agent, model: modelStr ?? "default", sessionID, promptLen: prompt.length, files: fileParts.length })
      const result = yield* sessionPrompt.prompt(input).pipe(Effect.catch(() => Effect.succeed(undefined as any)))
      if (!result) return { content: "❌ Processing error." }

      const responseText = (result.parts as any[]).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n").trim()
      const elapsed = Date.now() - startTime
      Effect.logInfo("webhook.done", { source: sourceName, command: commandName, model: modelStr ?? "default", totalTime: elapsed, len: responseText.length, text: truncate(responseText, 500) })
      return { content: responseText || "✅ Done." }
    })

    const ingress = (ctx: { params: { source: string }; payload: unknown }) =>
      run(ctx).pipe(Effect.catchCause(() => Effect.succeed({ content: "❌ Internal error." } as const)))

    const reload = Effect.fn("Webhook.reload")(function* () {
      cachedConfig = null
      cachedCommands.clear()
      Effect.logInfo("webhook.cache_reloaded", {})
      return { content: "✅ Cache reloaded." }
    })

    return handlers.handle("ingress", ingress).handle("reload", reload)
  }),
)
