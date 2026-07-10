// Универсальный хендлер вебхуков.
// POST /webhook/:source — source из URL (zulip, telegram, …).
// 1. Читает .legion/integrations.jsonc → находит source по name
// 2. Routing: stream → command
// 3. Читает команду .legion/command/{name}.md
// 4. Рендерит шаблон ($SENDER, $STREAM, $TOPIC, $CONTENT)
// 5. Скачивает файлы (/user_uploads/...)
// 6. Вызывает LLM через SessionPrompt.Service.prompt()
// 7. Возвращает { content: "..." }

import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { PublicWebhookApi } from "../webhook"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/schema/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import * as path from "path"
import * as fs from "fs"
import { parse as parseJsonc } from "jsonc-parser"

const PROJECT_ROOT = process.env.LEGION_PROJECT_DIR ?? process.cwd()
const LEGION_DIR = path.join(PROJECT_ROOT, ".legion")
const ROUTING_PATH = path.join(LEGION_DIR, "integrations.jsonc")
const LOG_FILE = path.join(LEGION_DIR, "integration.log")

// Regex для поиска /user_uploads/... в тексте сообщения (Zulip-style file links)
const UPLOAD_PATH_RE = /\/user_uploads\/[\w\/.-]+/g
// Расширения текстовых файлов, содержимое которых можно вставить в промпт
const TEXT_EXTS = new Set([".txt", ".md", ".py", ".js", ".ts", ".json", ".yaml", ".yml", ".xml", ".csv", ".ini", ".cfg", ".conf", ".env", ".bashrc", ".zshrc", ".sh", ".bash", ".toml", ".lock", ".gitignore", ".editorconfig", ".dockerfile", ".sql", ".html", ".css", ".go", ".rs", ".java", ".rb", ".php", ".vue", ".svelte", ".jsx", ".tsx"])

function logFile(msg: string) {
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`) } catch {}
}

function parseFrontmatter(text: string): { agent: string; model?: string; mcp: Record<string, boolean>; allow: string[]; body: string } {
  if (!text.startsWith("---")) return { agent: "general", mcp: {}, allow: [], body: text.trim() }
  const parts = text.split("---")
  if (parts.length < 3) return { agent: "general", mcp: {}, allow: [], body: text.trim() }
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
    body: parts.slice(2).join("---").trim(),
  }
}

export const webhookHandlers = HttpApiBuilder.group(PublicWebhookApi, "webhooks", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const fs = yield* FSUtil.Service

    const run = Effect.fn("Webhook.ingress")(function* (ctx: { params: { source: string }; payload: unknown }) {
      const startTime = Date.now()
      const sourceName = ctx.params.source
      const payload = ctx.payload as any
      const msg = payload?.message ?? {}

      // Поля, специфичные для источника (Zulip, Telegram, …)
      const senderEmail = msg.sender_email ?? ""
      const sender = msg.sender_full_name ?? msg.sender_username ?? msg.from ?? "Unknown"
      const content = msg.content ?? msg.text ?? ""
      const stream = msg.type === "stream"
        ? (typeof msg.display_recipient === "string" ? msg.display_recipient : msg.chat ?? "dm")
        : "dm"
      const topic = msg.topic ?? ""

      logFile(`RAW [${sourceName}]: sender=${sender} stream=${stream} topic=${topic} contentLen=${content.length}`)

      // ── 1. Конфиг ───────────────────────────────────────────────────
      const configText = yield* fs.readFileStringSafe(ROUTING_PATH).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!configText) return { content: "❌ Config not found." }
      const config: any = parseJsonc(configText)
      const source = config?.sources?.find((s: any) => s.name === sourceName)
      if (!source) return { content: `❌ Source "${sourceName}" not configured.` }

      const zulipUrl = process.env.LEGION_ZULIP_URL ?? source.zulip_url
      const botApiKeys: Record<string, string> = source.bot_api_keys ?? {}
      const commandsDir = path.resolve(PROJECT_ROOT, source.commands_dir ?? ".legion/command")

      // ── 2. Файлы ────────────────────────────────────────────────────
      const fileParts: Array<{ url: string; mime: string; filename: string }> = []
      if (zulipUrl) {
        for (const uploadPath of [...new Set([...content.matchAll(UPLOAD_PATH_RE)].map(m => m[0].replace(/[?\s].*$/, "")))]) {
          const f = yield* Effect.tryPromise(async () => {
            const clean = uploadPath.replace(/[)\]>'".,;:!]+$/, "")
            const apiKey = botApiKeys[payload.bot_email ?? ""]
            if (!apiKey) { logFile(`download SKIP ${clean}: no api_key for ${payload.bot_email}`); return null }
            const res = await fetch(`${zulipUrl}${clean}?api_key=${apiKey}`, { headers: { "User-Agent": "LegionBot/1.0" }, redirect: "follow" })
            if (!res.ok) { logFile(`download FAIL ${clean} status=${res.status}`); return null }
            const mime = res.headers.get("content-type") ?? "application/octet-stream"
            const bytes = await res.arrayBuffer()
            logFile(`downloaded: ${path.basename(clean)} mime=${mime} size=${bytes.byteLength}`)
            return { url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`, mime, filename: path.basename(clean) }
          }).pipe(Effect.catch(() => Effect.succeed(null)))
          if (f) fileParts.push(f)
        }
      }

      // ── 3. Routing ──────────────────────────────────────────────────
      let commandName = config.default_command ?? "default"
      for (const rule of source.routing ?? []) {
        const matchField = rule.field ?? "stream"
        const matchValue = matchField === "stream" ? stream
          : matchField === "chat_id" ? (msg.chat_id ?? msg.chat ?? "")
          : ""
        const pattern = (rule as any)[matchField] ?? "*"
        if (pattern === "*" || pattern === matchValue) {
          if (rule.command) commandName = rule.command
          logFile(`route: ${matchField}="${pattern}" -> "${commandName}"`)
          break
        }
      }

      // ── 4. Команда ─────────────────────────────────────────────────
      const text = yield* fs.readFileStringSafe(path.join(commandsDir, `${commandName}.md`)).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!text) return { content: `❌ Command "${commandName}" not found.` }
      const { agent, model: modelStr, mcp, allow, body } = parseFrontmatter(text)
      logFile(`command: ${commandName} agent=${agent} model=${modelStr ?? "default"} mcp=${JSON.stringify(mcp)} allow=${JSON.stringify(allow)} body_chars=${body.length}`)

      // ── 5. Allow check ──────────────────────────────────────────────
      if (allow.length > 0) {
        const matched = allow.some(pattern => {
          if (pattern === senderEmail) return true
          if (pattern.endsWith("*") && senderEmail.startsWith(pattern.slice(0, -1))) return true
          if (pattern.startsWith("*") && senderEmail.endsWith(pattern.slice(1))) return true
          return false
        })
        if (!matched) {
          logFile(`DENY: sender=${senderEmail} not in allow=${JSON.stringify(allow)}`)
          return { content: "❌ Access denied." }
        }
        logFile(`ALLOW: sender=${senderEmail}`)
      }

      // ── 6. Рендер ──────────────────────────────────────────────────
      const fields: Record<string, string> = {
        $SENDER: sender,
        $STREAM: stream,
        $TOPIC: topic,
        $CONTENT: content,
        $SOURCE: sourceName,
      }
      let prompt = body
      for (const [key, val] of Object.entries(fields)) prompt = prompt.replaceAll(key, val)
      for (const fp of fileParts) {
        const ext = path.extname(fp.filename).toLowerCase()
        if (fp.mime.startsWith("text/") || fp.mime === "application/json" || fp.mime === "application/xml" || fp.mime === "application/yaml" || TEXT_EXTS.has(ext) || ext === ".bashrc") {
          try { prompt += `\n\n--- ${fp.filename} ---\n${Buffer.from(fp.url.split(",")[1], "base64").toString("utf-8").slice(0, 3000)}` } catch {}
        } else { prompt += `\n\n[File: ${fp.filename} (${fp.mime})]` }
      }
      logFile(`PROMPT:\n${prompt}`)

      // ── 6. Модель ──────────────────────────────────────────────────
      let modelInput: { providerID: string; modelID: string } | undefined
      if (modelStr?.includes("/")) {
        const [pid, mid] = modelStr.split("/")
        const provider = yield* Provider.Service
        const found = yield* provider.getModel(ProviderV2.ID.make(pid), ModelV2.ID.make(mid)).pipe(Effect.catch(() => Effect.succeed(undefined as any)))
        if (found) { modelInput = { providerID: ProviderV2.ID.make(pid), modelID: ModelV2.ID.make(mid) }; logFile(`model resolved: ${modelStr}`) }
        else { return { content: `❌ Модель "${modelStr}" не найдена. Укажи существующую модель в frontmatter команды.` } }
      }

      // ── 7. LLM ─────────────────────────────────────────────────────
      const sessionID = SessionV2.ID.create()
      yield* sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(PROJECT_ROOT) }),
      }).pipe(Effect.catch(() => Effect.void))

      const sessionPrompt = yield* SessionPrompt.Service
      const input: any = { sessionID, agent, parts: [{ type: "text" as const, text: prompt }] }
      if (modelInput) input.model = modelInput
      if (Object.keys(mcp).length > 0) input.tools = mcp

      Effect.logInfo("webhook session", { source: sourceName, command: commandName, agent, model: modelStr ?? "default", sessionID, promptLen: prompt.length, files: fileParts.length })
      const result = yield* sessionPrompt.prompt(input).pipe(Effect.catch(() => Effect.succeed(undefined as any)))
      if (!result) return { content: "❌ Processing error." }

      const responseText = (result.parts as any[]).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n").trim()
      const elapsed = Date.now() - startTime
      logFile(`RESPONSE total=${elapsed}ms chars=${responseText.length}\n${responseText}`)
      Effect.logInfo("webhook done", { source: sourceName, command: commandName, model: modelStr ?? "default", totalTime: elapsed, len: responseText.length })
      return { content: responseText || "✅ Done." }
    })

    const ingress = (ctx: { params: { source: string }; payload: unknown }) =>
      run(ctx).pipe(Effect.catchCause(() => Effect.succeed({ content: "❌ Internal error." } as const)))

    return handlers.handle("ingress", ingress)
  }),
)
