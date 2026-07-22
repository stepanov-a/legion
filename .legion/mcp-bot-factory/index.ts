#!/usr/bin/env bun
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import * as fs from "fs"
import * as path from "path"

// ── ENV ──────────────────────────────────────────────────────────
const PROJECT_ROOT = process.env.LEGION_PROJECT_DIR
if (!PROJECT_ROOT) { console.error("LEGION_PROJECT_DIR is required"); process.exit(1) }

const ZULIP_URL = process.env.ZULIP_URL
if (!ZULIP_URL) { console.error("ZULIP_URL is required"); process.exit(1) }
const ZULIP_EMAIL = process.env.ZULIP_EMAIL
if (!ZULIP_EMAIL) { console.error("ZULIP_EMAIL is required"); process.exit(1) }
const ZULIP_API_KEY = process.env.ZULIP_API_KEY
if (!ZULIP_API_KEY) { console.error("ZULIP_API_KEY is required"); process.exit(1) }

const S3_ENDPOINT = process.env.S3_ENDPOINT
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY
const S3_SECRET_KEY = process.env.S3_SECRET_KEY
const S3_BUCKET = process.env.S3_BUCKET
const S3_REGION = process.env.S3_REGION ?? "us-east-1"

const s3Available = !!(S3_ENDPOINT && S3_ACCESS_KEY && S3_SECRET_KEY && S3_BUCKET)

let s3Client: S3Client | null = null
if (s3Available) {
  s3Client = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    credentials: { accessKeyId: S3_ACCESS_KEY!, secretAccessKey: S3_SECRET_KEY! },
    forcePathStyle: true,
  })
}

const LEGION_PAYLOAD_URL = process.env.LEGION_PAYLOAD_URL ?? "http://legion.local:3000/webhook/zulip"
const LEGION_RELOAD_URL = "http://localhost:3000/webhook/reload"

function reloadWebhookCache(): void {
  fetch(LEGION_RELOAD_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {})
}
const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "opencode-go/deepseek-v4-flash"
const LEGION_DIR = path.join(PROJECT_ROOT, ".legion")
const COMMANDS_DIR = path.join(LEGION_DIR, "command")
const INTEGRATIONS_PATH = path.join(LEGION_DIR, "integrations.jsonc")
const BOTS_PATH = path.join(LEGION_DIR, "bots.jsonc")
const authHeader = "Basic " + Buffer.from(`${ZULIP_EMAIL}:${ZULIP_API_KEY}`).toString("base64")

// ── MCP helpers ──────────────────────────────────────────────────
const log = (msg: string) => process.stderr.write(msg + "\n")

const respond = (id: number | string | null, result?: unknown, error?: unknown) => {
  const msg: Record<string, unknown> = { jsonrpc: "2.0" }
  if (id !== null) msg.id = id
  if (error) msg.error = error
  else msg.result = result
  process.stdout.write(JSON.stringify(msg) + "\n")
}

// ── Zulip API ────────────────────────────────────────────────────
const ZULIP_API_HOST = process.env.ZULIP_API_HOST ?? ""

async function zulipFetch(path: string, init: RequestInit = {}): Promise<any> {
  const headers: Record<string, string> = {
    Authorization: authHeader,
    "Content-Type": "application/x-www-form-urlencoded",
    ...(init.headers as Record<string, string>),
  }
  if (ZULIP_API_HOST) headers["Host"] = ZULIP_API_HOST
  const res = await fetch(`${ZULIP_URL}/api/v1${path}`, {
    ...init,
    headers,
  })
  const json = await res.json()
  if (json.result !== "success") throw new Error(json.msg ?? `Zulip error (${res.status})`)
  return json
}

// ── Helpers ──────────────────────────────────────────────────────
function sanitizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-_]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
}

function buildMd(fields: Record<string, string>, body: string): string {
  const fm = Object.entries(fields)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")
  return `---\n${fm}\n---\n\n${body}\n`
}

function parseFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  const frontmatter: Record<string, string> = {}
  if (!text.startsWith("---")) return { frontmatter, body: text.trim() }
  const parts = text.split("---")
  if (parts.length < 3) return { frontmatter, body: text.trim() }
  const fmLines = parts[1].trim().split("\n")
  for (const line of fmLines) {
    const idx = line.indexOf(":")
    if (idx > 0) frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return { frontmatter, body: parts.slice(2).join("---").trim() }
}

function buildFrontmatter(fields: Record<string, string>): string {
  return Object.entries(fields)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")
}

function checkAllow(allowStr: string, senderEmail: string): boolean {
  if (!allowStr || !senderEmail) return !allowStr
  if (allowStr === "[]" || allowStr === "''" || allowStr === '""') return true
  const allowMatch = allowStr.match(/\[([^\]]*)\]/)
  if (!allowMatch) return true
  const patterns = allowMatch[1].split(",").map(s => s.trim().replace(/['"]/g, ""))
  return patterns.some(pattern => {
    if (pattern === senderEmail) return true
    if (pattern.endsWith("*") && senderEmail.startsWith(pattern.slice(0, -1))) return true
    if (pattern.startsWith("*") && senderEmail.endsWith(pattern.slice(1))) return true
    return false
  })
}

// ── Zulip helpers ────────────────────────────────────────────────
async function zulipDeleteBot(botEmail: string): Promise<boolean> {
  try {
    const bots = await zulipFetch("/bots")
    const bot = (bots.bots ?? []).find((b: any) => b.email === botEmail)
    if (!bot) return false
    await zulipFetch(`/bots/${bot.user_id}`, { method: "DELETE" })
    return true
  } catch { return false }
}

// ── BotConfig синглтон ──────────────────────────────────────────
interface BotEntry {
  name: string
  description: string
  agent: string
  stream: string
  model?: string
  mcp?: Record<string, boolean>
  allow?: string[]
  ragflow_dataset?: string
  zulip_email?: string
  zulip_api_key?: string
  zulip_user_id?: number
  self_update?: boolean
  service_tokens?: string[]  // webhook service tokens (populated from first webhook)
}

interface BotsConfig {
  bots: BotEntry[]
}

function botConfigS3Key(name: string): string {
  return `bot-prompts/${name}/config.json`
}

function botPromptS3Key(name: string): string {
  return `bot-prompts/${name}/prompt.md`
}

async function syncPromptToS3(name: string, content: string): Promise<boolean> {
  if (!s3Client) return false
  try {
    await s3Client.send(new PutObjectCommand({
      Bucket: S3_BUCKET!,
      Key: botPromptS3Key(name),
      Body: content,
      ContentType: "text/markdown",
    }))
    return true
  } catch { return false }
}

async function deletePromptFromS3(name: string): Promise<boolean> {
  if (!s3Client) return false
  try {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3")
    await s3Client.send(new DeleteObjectCommand({
      Bucket: S3_BUCKET!,
      Key: botPromptS3Key(name),
    }))
    return true
  } catch { return false }
}

async function pullPromptFromS3(name: string): Promise<string | null> {
  if (!s3Client) return null
  try {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3")
    const res = await s3Client.send(new GetObjectCommand({
      Bucket: S3_BUCKET!,
      Key: botPromptS3Key(name),
    }))
    return await res.Body!.transformToString("utf-8")
  } catch { return null }
}

class BotConfig {
  private cfg: BotsConfig | null = null

  private path(): string { return BOTS_PATH }

  load(): BotsConfig {
    if (this.cfg) return this.cfg
    try {
      const raw = fs.readFileSync(this.path(), "utf-8")
      this.cfg = JSON.parse(raw) as BotsConfig
      if (!Array.isArray(this.cfg.bots)) this.cfg.bots = []
    } catch {
      this.cfg = { bots: [] }
    }
    return this.cfg
  }

  private save(): void {
    fs.writeFileSync(this.path(), JSON.stringify(this.cfg, null, 2) + "\n", "utf-8")
  }

  addBot(entry: BotEntry): void {
    const cfg = this.load()
    if (cfg.bots.find(b => b.name === entry.name)) throw new Error(`Bot "${entry.name}" already exists`)
    cfg.bots.push(entry)
    this.save()
    this.syncPerBotConfigToS3(entry.name)
  }

  updateBot(name: string, updates: Partial<BotEntry>): BotEntry | null {
    const cfg = this.load()
    const idx = cfg.bots.findIndex(b => b.name === name)
    if (idx < 0) return null
    cfg.bots[idx] = { ...cfg.bots[idx], ...updates }
    this.save()
    this.syncPerBotConfigToS3(name)
    return cfg.bots[idx]
  }

  deleteBot(name: string): BotEntry | null {
    const cfg = this.load()
    const idx = cfg.bots.findIndex(b => b.name === name)
    if (idx < 0) return null
    const removed = cfg.bots.splice(idx, 1)[0]
    this.save()
    return removed
  }

  getBot(name: string): BotEntry | undefined {
    return this.load().bots.find(b => b.name === name)
  }

  listBots(): BotEntry[] {
    return [...this.load().bots]
  }

  botEmail(name: string): string {
    const bot = this.getBot(name)
    return bot?.zulip_email ?? ""
  }

  getServiceToken(name: string): string | undefined {
    const bot = this.getBot(name)
    return bot?.service_tokens?.[0]
  }

  addServiceToken(name: string, token: string): void {
    const bot = this.getBot(name)
    if (!bot) return
    if (!bot.service_tokens) bot.service_tokens = []
    if (!bot.service_tokens.includes(token)) {
      bot.service_tokens.push(token)
      this.save()
      this.syncPerBotConfigToS3(name)
    }
  }

  // per-bot config in S3: bot-prompts/{name}/config.json
  async syncPerBotConfigToS3(name: string): Promise<void> {
    if (!s3Client) return
    const bot = this.getBot(name)
    if (!bot) return
    try {
      await s3Client.send(new PutObjectCommand({
        Bucket: S3_BUCKET!,
        Key: botConfigS3Key(name),
        Body: JSON.stringify(bot, null, 2),
        ContentType: "application/json",
      }))
    } catch {}
  }

  async loadPerBotConfigFromS3(name: string): Promise<BotEntry | null> {
    if (!s3Client) return null
    try {
      const { GetObjectCommand } = await import("@aws-sdk/client-s3")
      const res = await s3Client.send(new GetObjectCommand({
        Bucket: S3_BUCKET!,
        Key: botConfigS3Key(name),
      }))
      const text = await res.Body!.transformToString("utf-8")
      return JSON.parse(text) as BotEntry
    } catch {
      return null
    }
  }

  syncRoutingToIntegrations(): void {
    try {
      let intCfg: any
      try {
        intCfg = JSON.parse(fs.readFileSync(INTEGRATIONS_PATH, "utf-8"))
      } catch {
        intCfg = { sources: [{ name: "zulip", type: "webhook", routing: [] }] }
      }
      const zulipSource = intCfg.sources?.find((s: any) => s.name === "zulip")
      if (!zulipSource) return

      const cfg = this.load()
      for (const bot of cfg.bots) {
        // Stream routing
        const existing = (zulipSource.routing ?? []).findIndex((r: any) => r.command === bot.name && !r.field)
        const route = { stream: bot.stream, command: bot.name }
        if (existing >= 0) zulipSource.routing[existing] = route
        else {
          const wildcardIdx = (zulipSource.routing ?? []).findIndex((r: any) =>
            r.stream === "*" || r.chat_id === "*"
          )
          if (!zulipSource.routing) zulipSource.routing = []
          if (wildcardIdx >= 0) zulipSource.routing.splice(wildcardIdx, 0, route)
          else zulipSource.routing.push(route)
        }

        // bot_email routing (for DMs)
        if (bot.zulip_email) {
          const emailExisting = (zulipSource.routing ?? []).findIndex((r: any) =>
            r.field === "bot_email" && r.bot_email === bot.zulip_email
          )
          const emailRoute = { field: "bot_email", bot_email: bot.zulip_email, command: bot.name }
          if (emailExisting < 0) {
            const wildcardIdx = (zulipSource.routing ?? []).findIndex((r: any) =>
              r.stream === "*" || r.chat_id === "*"
            )
            if (wildcardIdx >= 0) zulipSource.routing.splice(wildcardIdx, 0, emailRoute)
            else zulipSource.routing.push(emailRoute)
          }
        }
      }
      fs.writeFileSync(INTEGRATIONS_PATH, JSON.stringify(intCfg, null, 2) + "\n", "utf-8")
      reloadWebhookCache()
    } catch {}
  }

  removeRoutingFromIntegrations(botName: string): void {
    try {
      const intCfg = JSON.parse(fs.readFileSync(INTEGRATIONS_PATH, "utf-8"))
      const zulipSource = intCfg.sources?.find((s: any) => s.name === "zulip")
      if (!zulipSource) return
      zulipSource.routing = (zulipSource.routing ?? []).filter((r: any) => r.command !== botName)
      fs.writeFileSync(INTEGRATIONS_PATH, JSON.stringify(intCfg, null, 2) + "\n", "utf-8")
      reloadWebhookCache()
    } catch {}
  }
}

const botConfig = new BotConfig()

// ── Tools ────────────────────────────────────────────────────────
const tools = [
  {
    name: "create_bot",
    description: "Создать нового бота Legion: .md команда + Zulip-бот + routing + S3 backup",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Уникальное имя команды (латиница, без пробелов). Будет именем файла .legion/command/{name}.md" },
        description: { type: "string", description: "Описание бота (для frontmatter)" },
        prompt: { type: "string", description: "Полный текст промпта команды. Используй $SENDER, $STREAM, $TOPIC, $CONTENT, $SOURCE как переменные" },
        stream: { type: "string", description: "Zulip-канал для routing (например general, admin). * — любой" },
        agent: { type: "string", description: "Агент opencode (general, architect и т.д.)", default: "general" },
        model: { type: "string", description: "Модель (например opencode-go/deepseek-v4-flash). По умолчанию из DEFAULT_MODEL env.", default: "" },
        allow: { type: "string", description: "Whitelist email'ов через запятую (опционально)", default: "" },
        mcp: { type: "string", description: "MCP-инструменты через запятую (опционально, например ragflow-proxy,zulip)", default: "" },
        ragflow_dataset: { type: "string", description: "RAGFlow dataset ID для фоновой индексации файлов (опционально)", default: "" },
        self_update: { type: "boolean", description: "Добавить возможность self-update: bot-factory в mcp + инструкция в промпт (опционально)", default: false },
      },
      required: ["name", "description", "prompt"],
    },
  },
  {
    name: "list_bots",
    description: "Список всех зарегистрированных ботов Legion (из bots.jsonc + команд)",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_bot",
    description: "Полная информация о конкретном боте: .md конфиг, routing, Zulip-данные",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Имя команды (файл .legion/command/{name}.md)" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_bot",
    description: "Обновить промпт и/или frontmatter существующего бота. Старая версия — в S3 backup.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Имя команды (обязательно)" },
        prompt: { type: "string", description: "Новый текст промпта (опционально)", default: "" },
        description: { type: "string", description: "Новое описание (опционально)", default: "" },
        model: { type: "string", description: "Новая модель (опционально)", default: "" },
        allow: { type: "string", description: "Новый whitelist email'ов через запятую (опционально, пустая строка — снять ограничение)", default: "" },
        mcp: { type: "string", description: "Новый список MCP-инструментов через запятую (опционально)", default: "" },
        ragflow_dataset: { type: "string", description: "Новый RAGFlow dataset ID (опционально, пустая строка — убрать)", default: "" },
        stream: { type: "string", description: "Новый канал для routing (опционально)", default: "" },
        agent: { type: "string", description: "Новый агент (опционально)", default: "" },
        sender_email: { type: "string", description: "Email отправителя для проверки allow (если allow установлен)", default: "" },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_bot",
    description: "Полностью удалить бота: деактивировать Zulip-бота, удалить .md, очистить routing. Бэкап в S3.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Имя команды" },
      },
      required: ["name"],
    },
  },
  {
    name: "reset_session",
    description: "Сбросить сессию диалога (очистить историю LLM). После этого следующий запрос начнётся с чистого контекста.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
]

// ── Tool handlers ────────────────────────────────────────────────
async function handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (name) {
    case "create_bot": {
      const rawName = String(args.name ?? "").trim()
      const description = String(args.description ?? "").trim()
      const promptBody = String(args.prompt ?? "").trim()
      const stream = String(args.stream ?? "*").trim()
      const agent = String(args.agent ?? "general").trim()
      const modelStr = String(args.model ?? "").trim()
      const allow = String(args.allow ?? "").trim()
      const mcpStr = String(args.mcp ?? "").trim()
      const ragflowDataset = String(args.ragflow_dataset ?? "").trim()
      const selfUpdate = args.self_update === true

      if (!rawName || !description || !promptBody) {
        throw new Error("name, description, and prompt are required")
      }

      const safeName = sanitizeName(rawName)
      if (!safeName) throw new Error(`Invalid name "${rawName}" — use latin letters, numbers, hyphens`)

      const results: string[] = []

      // 1. Создаём .md файл команды
      const frontmatter: Record<string, string> = { name: safeName, description, agent }
      frontmatter.model = modelStr || DEFAULT_MODEL
      if (allow) frontmatter.allow = JSON.stringify(allow.split(",").map((s: string) => s.trim()))
      if (mcpStr || selfUpdate) {
        const mcpObj: Record<string, boolean> = {}
        for (const t of mcpStr.split(",").map((s: string) => s.trim())) {
          if (t) mcpObj[t] = true
        }
        if (selfUpdate) {
          mcpObj["bot-factory"] = true
          results.push("✅ Self-update включён: bot-factory добавлен в mcp")
        }
        frontmatter.mcp = JSON.stringify(mcpObj)
      }
      if (ragflowDataset) frontmatter.ragflow_dataset = ragflowDataset

      let finalPrompt = promptBody
      if (selfUpdate) {
        finalPrompt += `\n\n### Самообновление (self-update)\nЕсли пользователь явно попросит обновить твой промпт или конфигурацию:\n1. Используй \`get_bot\` из bot-factory чтобы прочитать свой текущий .md\n2. Обсуди с пользователем изменения\n3. Используй \`update_bot\` для применения изменений\nСтарая версия автоматически сохранится в S3 как бэкап.\nSelf-update работает только если allow пользователя совпадает.`
        results.push("✅ Self-update инструкция добавлена в промпт")
      }

      const mdContent = buildMd(frontmatter, finalPrompt)
      const mdPath = path.join(COMMANDS_DIR, `${safeName}.md`)

      if (fs.existsSync(mdPath)) {
        throw new Error(`Command file already exists: ${safeName}.md`)
      }
      fs.writeFileSync(mdPath, mdContent, "utf-8")
      results.push(`✅ Команда \`${safeName}.md\` создана`)

      // 1b. Сохраняем промпт в S3 (primary storage)
      const s3PromptOk = await syncPromptToS3(safeName, mdContent)
      if (s3PromptOk) results.push(`✅ Промпт сохранён в S3: \`${botPromptS3Key(safeName)}\``)

      // 2. Создаём Zulip-бота
      const shortName = safeName.replace(/-/g, "")
      const payloadUrl = LEGION_PAYLOAD_URL
      let botData: any
      try {
        botData = await zulipFetch("/bots", {
          method: "POST",
          body: new URLSearchParams({ full_name: safeName, short_name: shortName, bot_type: "3" }).toString(),
        })
      } catch (e: any) {
        fs.unlinkSync(mdPath)
        throw new Error(`Failed to create Zulip bot: ${e.message}`)
      }

      const botUserId = botData.user_id
      const botEmail = botData.email ?? `${shortName}-bot@zulip.local`
      const botApiKey = botData.api_key ?? ""

      await zulipFetch(`/bots/${botUserId}`, {
        method: "PATCH",
        body: new URLSearchParams({ service_interface: "1", service_payload_url: JSON.stringify(payloadUrl) }).toString(),
      })
      results.push(`✅ Zulip-бот \`${description}\` создан (${botEmail})`)

      // 2b. Подписываем бота на канал (чтобы работали сообщения из stream, не только DM)
      if (stream && stream !== "*") {
        try {
          await zulipFetch("/users/me/subscriptions", {
            method: "POST",
            body: new URLSearchParams({
              subscriptions: JSON.stringify([{ name: stream }]),
              principals: JSON.stringify([botEmail]),
            }).toString(),
          })
          results.push(`✅ Бот подписан на канал #${stream}`)
        } catch (e: any) {
          results.push(`⚠️ Не удалось подписать бота на канал #${stream}: ${e.message}`)
        }
      }

      // 3. Регистрируем в BotConfig (write per-bot config to S3)
      const allowList = allow ? allow.split(",").map((s: string) => s.trim()) : undefined
      let mcpObj: Record<string, boolean> | undefined
      if (mcpStr || selfUpdate) {
        mcpObj = {}
        for (const t of mcpStr.split(",").map((s: string) => s.trim())) {
          if (t) mcpObj[t] = true
        }
        if (selfUpdate) mcpObj["bot-factory"] = true
      }
      botConfig.addBot({
        name: safeName,
        description,
        agent,
        stream,
        model: modelStr || undefined,
        mcp: mcpObj,
        allow: allowList,
        ragflow_dataset: ragflowDataset || undefined,
        zulip_email: botEmail,
        zulip_api_key: botApiKey,
        zulip_user_id: botUserId,
        self_update: selfUpdate || undefined,
      })
      results.push(`✅ Бот зарегистрирован в S3: \`${botConfigS3Key(safeName)}\``)

      // 4. Синхронизируем routing в integrations.jsonc (только stream mapping)
      botConfig.syncRoutingToIntegrations()
      results.push(`✅ Routing #${stream} → ${safeName} добавлен в integrations.jsonc`)

      // 5. Сохраняем промпт в S3 как backup
      if (s3Client) {
        const s3Key = `bot-prompts/${safeName}/${Date.now()}_${safeName}.md`
        try {
          await s3Client.send(new PutObjectCommand({
            Bucket: S3_BUCKET!,
            Key: s3Key,
            Body: mdContent,
            ContentType: "text/markdown",
          }))
          results.push(`✅ Промпт сохранён в S3: \`${s3Key}\``)
        } catch (e: any) {
          results.push(`⚠️ S3 backup не удался: ${e.message}`)
        }
      }

      return {
        content: [{
          type: "text",
          text: [
            `✅ Бот "${description}" полностью настроен.`,
            ``,
            `**Команда:** \`${safeName}\``,
            `**Zulip-бот:** ${botEmail}`,
            `**API key:** \`${botApiKey}\``,
            `**User ID:** ${botUserId}`,
            `**Webhook:** ${payloadUrl}`,
            `**Stream:** ${stream}`,
            `**Файл:** \`.legion/command/${safeName}.md\``,
            ``,
            ...results,
          ].join("\n"),
        }],
      }
    }

    case "list_bots": {
      const lines: string[] = []

      // Из BotConfig
      const bots = botConfig.listBots()
      if (bots.length > 0) {
        lines.push("## Зарегистрированные боты (bots.jsonc)")
        for (const b of bots) {
          const allowStr = b.allow ? ` [allow: ${b.allow.join(", ")}]` : ""
          lines.push(`- **${b.name}** — ${b.description} (${b.stream})${allowStr}`)
        }
      }

      // Из .legion/command/ (незарегистрированные)
      const mdFiles = new Set(bots.map(b => b.name))
      const unregistered: string[] = []
      try {
        for (const f of fs.readdirSync(COMMANDS_DIR).filter((f: string) => f.endsWith(".md"))) {
          const name = f.replace(/\.md$/, "")
          if (!mdFiles.has(name)) {
            unregistered.push(`- \`${f}\` (не зарегистрирован в bots.jsonc)`)
          }
        }
      } catch {}

      if (unregistered.length > 0) {
        lines.push("\n## Незарегистрированные команды")
        lines.push(...unregistered)
      }

      return { content: [{ type: "text", text: lines.join("\n") || "No bots found." }] }
    }

    case "get_bot": {
      const name = String(args.name ?? "").trim()
      if (!name) throw new Error("name is required")
      const safeName = sanitizeName(name)
      const mdPath = path.join(COMMANDS_DIR, `${safeName}.md`)
      if (!fs.existsSync(mdPath)) throw new Error(`Bot "${safeName}" not found: no .md file`)

      const mdContent = fs.readFileSync(mdPath, "utf-8")
      const { frontmatter, body } = parseFrontmatter(mdContent)
      const entry = botConfig.getBot(safeName)

      const lines: string[] = [
        `## Бот: ${safeName}`,
        ``,
        `### Frontmatter`,
        ...Object.entries(frontmatter).map(([k, v]) => `- **${k}:** ${v}`),
      ]

      if (entry) {
        lines.push(``, `### BotConfig (bots.jsonc)`)
        lines.push(`- **stream:** ${entry.stream}`)
        lines.push(`- **zulip_email:** ${entry.zulip_email ?? "(нет)"}`)
        if (entry.model) lines.push(`- **model:** ${entry.model}`)
        if (entry.allow) lines.push(`- **allow:** [${entry.allow.join(", ")}]`)
        if (entry.self_update) lines.push(`- **self_update:** да`)
      }

      lines.push(``, `### Промпт (первые 2000 символов)`)
      lines.push(body.slice(0, 2000) + (body.length > 2000 ? "\n..." : ""))

      return { content: [{ type: "text", text: lines.join("\n") }] }
    }

    case "update_bot": {
      const rawName = String(args.name ?? "").trim()
      if (!rawName) throw new Error("name is required")
      const safeName = sanitizeName(rawName)
      const mdPath = path.join(COMMANDS_DIR, `${safeName}.md`)
      if (!fs.existsSync(mdPath)) throw new Error(`Bot "${safeName}" not found`)

      const results: string[] = []
      const oldContent = fs.readFileSync(mdPath, "utf-8")
      const { frontmatter: oldFm, body: oldBody } = parseFrontmatter(oldContent)

      // Allow check
      const senderEmail = String(args.sender_email ?? "").trim()
      const oldAllowRaw = oldFm["allow"] ?? ""
      if (oldAllowRaw && senderEmail) {
        const allowed = checkAllow(oldAllowRaw, senderEmail)
        if (!allowed) throw new Error(`Access denied: ${senderEmail} not in allow list`)
        results.push(`✅ Allow check passed for ${senderEmail}`)
      }

      // Build new frontmatter
      const newFm: Record<string, string> = { ...oldFm }
      const newPrompt = String(args.prompt ?? "").trim()
      const newDescription = String(args.description ?? "").trim()
      const newModel = String(args.model ?? "").trim()
      const newAllow = String(args.allow ?? "").trim()
      const newMcp = String(args.mcp ?? "").trim()
      const newRagflow = String(args.ragflow_dataset ?? "").trim()
      const newStream = String(args.stream ?? "").trim()
      const newAgent = String(args.agent ?? "").trim()

      if (newDescription) { newFm["description"] = `"${newDescription}"`; results.push(`✅ description: "${newDescription}"`) }
      if (newModel) { newFm["model"] = newModel; results.push(`✅ model: ${newModel}`) }
      if (newAgent) { newFm["agent"] = newAgent; results.push(`✅ agent: ${newAgent}`) }
      if (args.allow !== undefined) {
        if (newAllow) {
          newFm["allow"] = JSON.stringify(newAllow.split(",").map((s: string) => s.trim()))
          results.push(`✅ allow: [${newAllow}]`)
        } else {
          delete newFm["allow"]
          results.push(`✅ allow: снят`)
        }
      }
      if (args.mcp !== undefined) {
        if (newMcp) {
          const mcpObj: Record<string, boolean> = {}
          for (const t of newMcp.split(",").map((s: string) => s.trim())) {
            if (t) mcpObj[t] = true
          }
          newFm["mcp"] = JSON.stringify(mcpObj)
          results.push(`✅ mcp: ${JSON.stringify(mcpObj)}`)
        } else {
          delete newFm["mcp"]
          results.push(`✅ mcp: пусто`)
        }
      }
      if (args.ragflow_dataset !== undefined) {
        if (newRagflow) { newFm["ragflow_dataset"] = newRagflow; results.push(`✅ ragflow_dataset: ${newRagflow}`) }
        else { delete newFm["ragflow_dataset"]; results.push(`✅ ragflow_dataset: убран`) }
      }

      const newBody = newPrompt || oldBody
      const newContent = `---\n${buildFrontmatter(newFm)}\n---\n\n${newBody}\n`

      // Backup old version to S3
      if (s3Client) {
        const backupKey = `bot-prompts/${safeName}/history/${Date.now()}_${safeName}.md`
        try {
          await s3Client.send(new PutObjectCommand({
            Bucket: S3_BUCKET!,
            Key: backupKey,
            Body: oldContent,
            ContentType: "text/markdown",
          }))
          results.push(`✅ Старая версия сохранена в S3: \`${backupKey}\``)
        } catch (e: any) {
          results.push(`⚠️ S3 backup не удался: ${e.message}`)
        }
      }

      // Write new .md (local + S3 primary)
      fs.writeFileSync(mdPath, newContent, "utf-8")
      results.push(`✅ \`${safeName}.md\` обновлён`)
      const s3PromptOk = await syncPromptToS3(safeName, newContent)
      if (s3PromptOk) results.push(`✅ Промпт синхронизирован в S3: \`${botPromptS3Key(safeName)}\``)

      // Update BotConfig (syncs to per-bot S3 config)
      const botUpdates: Partial<BotEntry> = {}
      if (newDescription) botUpdates.description = newDescription
      if (newAgent) botUpdates.agent = newAgent
      if (newModel) botUpdates.model = newModel
      if (newStream) botUpdates.stream = newStream
      if (args.allow !== undefined) botUpdates.allow = newAllow ? newAllow.split(",").map((s: string) => s.trim()) : undefined
      if (args.mcp !== undefined) {
        if (newMcp) {
          const mcpObj: Record<string, boolean> = {}
          for (const t of newMcp.split(",").map((s: string) => s.trim())) if (t) mcpObj[t] = true
          botUpdates.mcp = mcpObj
        } else {
          botUpdates.mcp = undefined
        }
      }
      if (args.ragflow_dataset !== undefined) botUpdates.ragflow_dataset = newRagflow || undefined

      const updated = botConfig.updateBot(safeName, botUpdates)
      if (updated) {
        results.push(`✅ BotConfig обновлён (S3: \`${botConfigS3Key(safeName)}\`)`)
        if (newStream) {
          botConfig.syncRoutingToIntegrations()
          results.push(`✅ Routing обновлён: ${newStream} → ${safeName}`)
        }
      }

      return {
        content: [{
          type: "text",
          text: [
            `✅ Бот "${safeName}" обновлён.`,
            ``,
            ...results,
          ].join("\n"),
        }],
      }
    }

    case "delete_bot": {
      const rawName = String(args.name ?? "").trim()
      if (!rawName) throw new Error("name is required")
      const safeName = sanitizeName(rawName)
      const mdPath = path.join(COMMANDS_DIR, `${safeName}.md`)
      if (!fs.existsSync(mdPath)) throw new Error(`Bot "${safeName}" not found`)

      const results: string[] = []
      const mdContent = fs.readFileSync(mdPath, "utf-8")

      // Backup to S3
      if (s3Client) {
        const backupKey = `bot-prompts/${safeName}/deleted/${Date.now()}_${safeName}.md`
        try {
          await s3Client.send(new PutObjectCommand({
            Bucket: S3_BUCKET!,
            Key: backupKey,
            Body: mdContent,
            ContentType: "text/markdown",
          }))
          results.push(`✅ Бэкап сохранён в S3: \`${backupKey}\``)
        } catch (e: any) {
          results.push(`⚠️ S3 backup не удался: ${e.message}`)
        }
      }

      // Deactivate Zulip bot
      const botEmail = botConfig.botEmail(safeName)
      if (botEmail) {
        const deactivated = await zulipDeleteBot(botEmail)
        if (deactivated) results.push(`✅ Zulip-бот ${botEmail} деактивирован`)
        else results.push(`⚠️ Zulip-бот ${botEmail} не найден для деактивации`)
      }

      // Remove .md file (local + S3 primary)
      fs.unlinkSync(mdPath)
      results.push(`✅ \`${safeName}.md\` удалён`)
      const s3DelOk = await deletePromptFromS3(safeName)
      if (s3DelOk) results.push(`✅ Промпт удалён из S3: \`${botPromptS3Key(safeName)}\``)

      // Remove from BotConfig + clean routing + clean S3 config
      const removed = botConfig.deleteBot(safeName)
      if (removed) {
        results.push(`✅ Удалён из локального конфига`)
        botConfig.removeRoutingFromIntegrations(safeName)
        results.push(`✅ Routing очищен из integrations.jsonc`)
        if (s3Client) {
          try {
            const { DeleteObjectCommand } = await import("@aws-sdk/client-s3")
            await s3Client.send(new DeleteObjectCommand({
              Bucket: S3_BUCKET!, Key: botConfigS3Key(safeName),
            }))
            results.push(`✅ S3-конфиг удалён: \`${botConfigS3Key(safeName)}\``)
          } catch {}
        }
      }

      return {
        content: [{
          type: "text",
          text: [`✅ Бот "${safeName}" полностью удалён.`, ``, ...results].join("\n"),
        }],
      }
    }

    case "reset_session": {
      try {
        const res = await fetch("http://localhost:3000/webhook/reset-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
        const text = await res.text()
        const json = JSON.parse(text)
        return { content: [{ type: "text", text: json.content ?? "✅ Session cache cleared." }] }
      } catch (e: any) {
        return { content: [{ type: "text", text: `❌ Failed to reset session: ${e.message}` }] }
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ── Main loop ──────────────────────────────────────────
const buf: string[] = []
const decoder = new TextDecoder()

for await (const chunk of Bun.stdin.stream()) {
  buf.push(decoder.decode(chunk))
  const text = buf.join("")
  const parts = text.split("\n")
  buf.length = 0
  buf.push(parts.pop() ?? "")

  for (const line of parts) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const req = JSON.parse(trimmed)
      const id = req.id ?? null

      if (req.method === "initialize") {
        respond(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "mcp-bot-factory", version: "1.0.0" },
        })
      } else if (req.method === "notifications/initialized") {
        // no response needed
      } else if (req.method === "tools/list") {
        respond(id, { tools })
      } else if (req.method === "tools/call") {
        try {
          const result = await handleToolCall(req.params.name, req.params.arguments ?? {})
          respond(id, result)
        } catch (e: any) {
          respond(id, null, { code: -32000, message: e.message ?? String(e) })
        }
      } else {
        respond(id, null, { code: -32601, message: `Method not found: ${req.method}` })
      }
    } catch (e: any) {
      log(`Parse error: ${e.message}`)
    }
  }
}
