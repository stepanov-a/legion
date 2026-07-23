#!/usr/bin/env bun
import * as path from "path"
import * as fs from "fs"

const LEGION_DIR = path.resolve(import.meta.dir, "..")
const BOTS_PATH = path.join(LEGION_DIR, "bots.jsonc")
const ZULIP_URL = process.env.ZULIP_URL ?? "https://zulip"
const ZULIP_HOST = process.env.ZULIP_API_HOST ?? "legion.zulip.local:8443"

interface BotEntry {
  name: string
  description?: string
  zulip_email: string
  zulip_api_key: string
  zulip_user_id?: number
  stream?: string
}

function loadBots(): Map<string, BotEntry> {
  const raw = JSON.parse(fs.readFileSync(BOTS_PATH, "utf-8"))
  const bots = new Map<string, BotEntry>()
  for (const b of (raw as { bots: BotEntry[] }).bots) {
    bots.set(b.name, b)
  }
  return bots
}

function auth(email: string, apiKey: string): string {
  return "Basic " + Buffer.from(`${email}:${apiKey}`).toString("base64")
}

async function zulipPost(email: string, apiKey: string, path: string, body: Record<string, string>): Promise<any> {
  const res = await fetch(`${ZULIP_URL}/api/v1${path}`, {
    method: "POST",
    headers: { Authorization: auth(email, apiKey), "Content-Type": "application/x-www-form-urlencoded", Host: ZULIP_HOST },
    body: new URLSearchParams(body).toString(),
  })
  const j = await res.json()
  if (j.result !== "success") throw new Error(j.msg ?? `Zulip API error (${res.status})`)
  return j
}

async function zulipGet(email: string, apiKey: string, path: string, query?: Record<string, string>): Promise<any> {
  const qs = query ? "?" + new URLSearchParams(query).toString() : ""
  const res = await fetch(`${ZULIP_URL}/api/v1${path}${qs}`, {
    method: "GET",
    headers: { Authorization: auth(email, apiKey), Host: ZULIP_HOST },
  })
  const j = await res.json()
  if (j.result !== "success") throw new Error(j.msg ?? `Zulip API error (${res.status})`)
  return j
}

const respond = (id: number | string | null, result?: unknown, error?: unknown) => {
  const msg: Record<string, unknown> = { jsonrpc: "2.0" }
  if (id !== null) msg.id = id
  if (error) msg.error = error
  else msg.result = result
  process.stdout.write(JSON.stringify(msg) + "\n")
}
const log = (msg: string) => process.stderr.write(msg + "\n")

const LEGION_WEBHOOK_URL = process.env.LEGION_WEBHOOK_URL ?? "http://localhost:3000/webhook/zulip"

const tools = [
  {
    name: "forward_to_bot",
    description: "Forward a message to another bot directly via Legio (not through Zulip). The target bot will process and respond automatically.",
    inputSchema: {
      type: "object",
      properties: {
        from_bot: { type: "string", description: "Your bot name (who is sending)" },
        to_bot: { type: "string", description: "Target bot name (who should receive)" },
        content: { type: "string", description: "Message content" },
      },
      required: ["from_bot", "to_bot", "content"],
    },
  },
  {
    name: "list_bots",
    description: "List all available bots that can send messages.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_conversations",
    description: "List recent messages from a bot's perspective in a stream or DM.",
    inputSchema: {
      type: "object",
      properties: {
        bot_name: { type: "string", description: "Bot name" },
        stream: { type: "string", description: "Stream name (omit for DMs)" },
        topic: { type: "string", description: "Topic (optional)" },
        limit: { type: "number", description: "Max messages", default: 10 },
      },
      required: ["bot_name"],
    },
  },
]

function formatBotList(bots: Map<string, BotEntry>): string {
  const lines: string[] = []
  for (const [, b] of bots) {
    lines.push(`- **${b.name}**: \`${b.zulip_email}\`${b.description ? ` — ${b.description}` : ""}`)
  }
  return lines.join("\n")
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  const bots = loadBots()

  switch (name) {
    case "forward_to_bot": {
      const fromName = String(args.from_bot ?? "").trim()
      const toName = String(args.to_bot ?? "").trim()
      const content = String(args.content ?? "")
      const fromBot = bots.get(fromName)
      const toBot = bots.get(toName)
      if (!fromBot) return { content: [{ type: "text", text: `❌ Bot "${fromName}" not found.` }] }
      if (!toBot) return { content: [{ type: "text", text: `❌ Bot "${toName}" not found.` }] }

      const targetStream = toBot.stream || toName
      const payload = {
        message: {
          sender_email: fromBot.zulip_email,
          sender_full_name: fromName,
          content: `[От ${fromName}]: ${content}`,
          type: "stream",
          display_recipient: targetStream,
          topic: "вопрос",
        },
        bot_email: toBot.zulip_email,
        token: "",
      }

      fetch(LEGION_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => {})
      return { content: [{ type: "text", text: `✅ Вопрос отправлен **${toName}**. Ответ будет в канале #**${targetStream}**.` }] }
    }

    case "list_bots": {
      return { content: [{ type: "text", text: `Available bots:\n${formatBotList(bots)}` }] }
    }

    case "list_conversations": {
      const botName = String(args.bot_name ?? "")
      const bot = bots.get(botName)
      if (!bot) {
        const available = [...bots.keys()].join(", ")
        return { content: [{ type: "text", text: `❌ Bot "${botName}" not found. Available bots: ${available}` }] }
      }

      const stream = args.stream ? String(args.stream) : undefined
      const topic = args.topic ? String(args.topic) : undefined
      const limit = Number(args.limit ?? 10)

      const narrow: Array<Record<string, string>> = [{ operator: "sender", operand: bot.zulip_email }]
      if (stream) narrow.push({ operator: "stream", operand: stream })
      if (stream && topic) narrow.push({ operator: "topic", operand: topic })
      const q: Record<string, string> = {
        anchor: "newest", num_before: String(limit), num_after: "0",
        narrow: JSON.stringify(narrow),
      }

      const res = await zulipGet(bot.zulip_email, bot.zulip_api_key, "/messages", q)
      const msgs = (res.messages as any[]).map((m: any) => {
        const where = Array.isArray(m.display_recipient)
          ? m.display_recipient.map((u: any) => u.full_name ?? u.email).join(", ")
          : `#${m.display_recipient}`
        return `> **${m.sender_full_name}** in ${where}${m.subject ? ` > ${m.subject}` : ""}:\n${(m.content as string).replace(/<[^>]+>/g, "").slice(0, 500)}`
      })
      return { content: [{ type: "text", text: msgs.join("\n\n") || "No messages found." }] }
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
  buf.length = 0; buf.push(parts.pop() ?? "")
  for (const line of parts) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const req = JSON.parse(trimmed); const id = req.id ?? null
      if (req.method === "initialize") respond(id, { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "mcp-zulip-messages", version: "1.0.0" } })
      else if (req.method === "notifications/initialized") {}
      else if (req.method === "tools/list") respond(id, { tools })
      else if (req.method === "tools/call") {
        try { respond(id, await handleToolCall(req.params.name, req.params.arguments ?? {})) }
        catch (e: any) { respond(id, null, { code: -32000, message: e.message ?? String(e) }) }
      } else respond(id, null, { code: -32601, message: `Method not found: ${req.method}` })
    } catch (e: any) { log(`Parse error: ${e.message}`) }
  }
}
