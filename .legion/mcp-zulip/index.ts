#!/usr/bin/env bun
import * as crypto from "crypto"
import * as path from "path"
import * as fs from "fs"
const ZULIP_URL = process.env.ZULIP_URL
if (!ZULIP_URL) { console.error("ZULIP_URL is required"); process.exit(1) }
const ZULIP_EMAIL = process.env.ZULIP_EMAIL
if (!ZULIP_EMAIL) { console.error("ZULIP_EMAIL is required"); process.exit(1) }
const ZULIP_API_KEY = process.env.ZULIP_API_KEY
if (!ZULIP_API_KEY) { console.error("ZULIP_API_KEY is required"); process.exit(1) }
const ZULIP_HOST = process.env.ZULIP_API_HOST ?? "legion.zulip.local:8443"

const authHeader = "Basic " + Buffer.from(`${ZULIP_EMAIL}:${ZULIP_API_KEY}`).toString("base64")

async function zulipFetch(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${ZULIP_URL}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
      Host: ZULIP_HOST,
      ...(init.headers as Record<string, string>),
    },
  })
  const json = await res.json()
  if (json.result !== "success") {
    log(`${init.method ?? "GET"} ${path} → ${res.status}: ${json.msg ?? JSON.stringify(json)}`)
    throw new Error(json.msg ?? `Zulip API error (${res.status})`)
  }
  return json
}

const zulipPost = async (path: string, body: Record<string, string>) =>
  zulipFetch(path, { method: "POST", body: new URLSearchParams(body).toString() })

const zulipPatch = async (path: string, body: Record<string, string>) =>
  zulipFetch(path, { method: "PATCH", body: new URLSearchParams(body).toString() })

const zulipGet = async (path: string, query?: Record<string, string>) => {
  const qs = query ? "?" + new URLSearchParams(query).toString() : ""
  return zulipFetch(path + qs, { method: "GET" })
}

// MCP protocol helpers
let messageId = 0
const respond = (id: number | string | null, result?: unknown, error?: unknown) => {
  const msg: Record<string, unknown> = { jsonrpc: "2.0" }
  if (id !== null) msg.id = id
  if (error) msg.error = error
  else msg.result = result
  process.stdout.write(JSON.stringify(msg) + "\n")
}

const log = (msg: string) => process.stderr.write(msg + "\n")

async function zulipDownload(urlPath: string): Promise<{ tmpPath: string; mime: string; filename: string; size: number }> {
  const clean = urlPath.replace(/[)\]>'".,;:!]+$/, "")
  const res = await fetch(`${ZULIP_URL}${clean}?api_key=${ZULIP_API_KEY}`, {
    headers: { Host: ZULIP_HOST, "User-Agent": "LegionBot/1.0" },
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
  const mime = res.headers.get("content-type") ?? "application/octet-stream"
  const buffer = Buffer.from(await res.arrayBuffer())
  const hash = crypto.createHash("md5").update(clean).digest("hex").slice(0, 8)
  const baseName = path.basename(clean)
  const tmpPath = `/tmp/legion_upload_${hash}_${baseName}`
  fs.writeFileSync(tmpPath, buffer)
  return { tmpPath, mime, filename: baseName, size: buffer.length }
}

const tools = [
  {
    name: "download_file",
    description: "Download a file from Zulip by its URL path (e.g. /user_uploads/.../file.pdf). Saves to /tmp and returns file metadata. The tmp_path can be passed to ragflow-proxy upload_document for indexing.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "File URL path from Zulip message (e.g. /user_uploads/12/abc123/report.pdf)" },
      },
      required: ["url"],
    },
  },
  {
    name: "send_message",
    description: "Send a message to a Zulip stream or direct conversation",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Stream name or user email (for DM)" },
        topic: { type: "string", description: "Topic name (for streams, optional)" },
        content: { type: "string", description: "Message content (Markdown)" },
        type: { type: "string", description: '"stream" (default) or "private"', default: "stream" },
      },
      required: ["to", "content"],
    },
  },
  {
    name: "create_stream",
    description: "Create a new Zulip stream/channel",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Stream name" },
        description: { type: "string", description: "Stream description", default: "" },
        invite_only: { type: "boolean", description: "Private stream", default: false },
      },
      required: ["name"],
    },
  },
  {
    name: "list_streams",
    description: "List all Zulip streams the bot can see",
    inputSchema: {
      type: "object",
      properties: {
        include_web_public: { type: "boolean", description: "Include web-public streams", default: false },
      },
      required: [],
    },
  },
  {
    name: "search_messages",
    description: "Search Zulip messages by keyword",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        stream: { type: "string", description: "Limit search to a stream (optional)" },
        limit: { type: "integer", description: "Max messages to return", default: 20 },
        topic: { type: "string", description: "Limit to a topic (requires stream)", default: "" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_stream_topics",
    description: "List all topics in a stream",
    inputSchema: {
      type: "object",
      properties: {
        stream: { type: "string", description: "Stream name" },
      },
      required: ["stream"],
    },
  },
  {
    name: "subscribe_users",
    description: "Subscribe users to a Zulip stream",
    inputSchema: {
      type: "object",
      properties: {
        stream: { type: "string", description: "Stream name" },
        users: { type: "string", description: "Comma-separated user emails or IDs" },
      },
      required: ["stream", "users"],
    },
  },
  {
    name: "get_user",
    description: "Get Zulip user info by email",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string", description: "User email" },
      },
      required: ["email"],
    },
  },
  {
    name: "create_bot",
    description: "Create a Zulip outgoing webhook bot (admin only)",
    inputSchema: {
      type: "object",
      properties: {
        short_name: { type: "string", description: "Bot handle (latin, no spaces). Email: {short_name}-bot@domain" },
        full_name: { type: "string", description: "Display name" },
        payload_url: { type: "string", description: "Webhook URL where Zulip sends POST" },
      },
      required: ["short_name", "full_name", "payload_url"],
    },
  },
  {
    name: "deactivate_bot",
    description: "Deactivate/delete a Zulip bot by user ID (admin only)",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "integer", description: "Bot user ID (get from create_bot or get_user)" },
      },
      required: ["user_id"],
    },
  },
]

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (name) {
    case "download_file": {
      const url = String(args.url ?? "")
      if (!url) throw new Error("url is required")
      const result = await zulipDownload(url)
      return { content: [{ type: "text", text: `✅ Downloaded: ${result.filename} (${result.size} bytes, ${result.mime})\nTmp path: ${result.tmpPath}` }] }
    }

    // ── send_message ──────────────────────────────────────────────────
    case "send_message": {
      const to = String(args.to ?? "")
      const content = String(args.content ?? "")
      const topic = args.topic ? String(args.topic) : undefined
      const type = String(args.type ?? "stream")
      const body: Record<string, string> = type === "private"
        ? { type: "private", to: to, content }
        : { type: "stream", to: to, content, ...(topic ? { topic } : {}) }
      const res = await zulipPost("/messages", body)
      return { content: [{ type: "text", text: `✅ Sent. Message ID: ${res.id}` }] }
    }

    // ── create_stream ─────────────────────────────────────────────────
    case "create_stream": {
      const name = String(args.name ?? "")
      const description = String(args.description ?? "")
      const invite_only = args.invite_only === true
      const res = await zulipPost("/users/me/subscriptions", {
        subscriptions: JSON.stringify([{ name, description }]),
        invite_only: invite_only ? "true" : "false",
      })
      return { content: [{ type: "text", text: `✅ Stream "${name}" created.` }] }
    }

    // ── list_streams ──────────────────────────────────────────────────
    case "list_streams": {
      const includeWebPublic = args.include_web_public === true
      const res = await zulipGet("/streams", includeWebPublic ? { include_web_public: "true" } : undefined)
      const streams = (res.streams as Array<{ name: string; stream_id: number; description: string }>)
        .map((s: any) => `- #${s.stream_id} **${s.name}**: ${s.description}`)
        .join("\n")
      return { content: [{ type: "text", text: streams || "No streams found." }] }
    }

    // ── search_messages ────────────────────────────────────────────────
    case "search_messages": {
      const query = String(args.query ?? "")
      const stream = args.stream ? String(args.stream) : undefined
      const topic = args.topic ? String(args.topic) : undefined
      const limit = Number(args.limit ?? 20)
      const q: Record<string, string> = { anchor: "newest", num_before: String(limit), num_after: "0" }
      const narrow: Array<Record<string, string>> = []
      if (stream) narrow.push({ operator: "stream", operand: stream })
      if (stream && topic) narrow.push({ operator: "topic", operand: topic })
      narrow.push({ operator: "search", operand: query })
      q.narrow = JSON.stringify(narrow)
      const res = await zulipGet("/messages", q)
      const msgs = (res.messages as any[]).map((m: any) => `> **${m.sender_full_name}** in #${m.display_recipient} > ${m.subject}:\n${(m.content as string).replace(/<[^>]+>/g, "").slice(0, 500)}`)
      return { content: [{ type: "text", text: msgs.join("\n\n") || "No messages found." }] }
    }

    // ── get_stream_topics ──────────────────────────────────────────────
    case "get_stream_topics": {
      const stream = String(args.stream ?? "")
      const streamsRes = await zulipGet("/streams")
      const found = (streamsRes.streams as any[]).find((s: any) => s.name === stream)
      if (!found) return { content: [{ type: "text", text: `❌ Stream "${stream}" not found.` }] }
      const res = await zulipGet(`/users/me/${found.stream_id}/topics`)
      const topics = (res.topics as any[]).map((t: any) => `- ${t.name} (${t.max_id} messages)`).join("\n")
      return { content: [{ type: "text", text: `Topics in #${stream}:\n${topics || "(none)"}` }] }
    }

    // ── subscribe_users ───────────────────────────────────────────────
    case "subscribe_users": {
      const stream = String(args.stream ?? "")
      const users = String(args.users ?? "")
      const emails = users.split(",").map((s: string) => s.trim()).filter(Boolean)
      const res = await zulipPost("/users/me/subscriptions", {
        subscriptions: JSON.stringify([{ name: stream }]),
        principals: JSON.stringify(emails),
      })
      const subscribed = (res.subscribed as any)?.[stream] ?? []
      return { content: [{ type: "text", text: `✅ Subscribed ${subscribed.length} user(s) to #${stream}.` }] }
    }

    // ── get_user ──────────────────────────────────────────────────────
    case "get_user": {
      const email = String(args.email ?? "")
      const res = await zulipGet("/users")
      const user = (res.members as any[]).find((u: any) => u.email === email)
      if (!user) return { content: [{ type: "text", text: `❌ User "${email}" not found.` }] }
      return { content: [{ type: "text", text: `- **${user.full_name}** (\`${user.email}\`)\n  Role: ${user.role}\n  ID: ${user.user_id}\n  Avatar: ${user.avatar_url}` }] }
    }

    // ── create_bot ────────────────────────────────────────────────────
    case "create_bot": {
      const shortName = String(args.short_name ?? "")
      const fullName = String(args.full_name ?? "")
      const payloadUrl = String(args.payload_url ?? "")
      const botData = await zulipPost("/bots", { full_name: fullName, short_name: shortName, bot_type: "3" })
      const userId = botData.user_id
      const botEmail = botData.email ?? `${shortName}-bot@${new URL(ZULIP_URL).hostname}`
      const botApiKey = botData.api_key ?? "(see below)"
      await zulipPatch(`/bots/${userId}`, { service_interface: "1", service_payload_url: JSON.stringify(payloadUrl) })
      return { content: [{ type: "text", text: [
        `✅ Bot "${fullName}" created.`,
        `- Email: \`${botEmail}\``,
        `- API key: \`${botApiKey}\``,
        `- Webhook URL: ${payloadUrl}`,
        `- User ID: ${userId}`,
      ].join("\n") }] }
    }

    // ── deactivate_bot ────────────────────────────────────────────────
    case "deactivate_bot": {
      const userId = Number(args.user_id ?? 0)
      if (!userId) throw new Error("user_id is required")
      await zulipFetch(`/bots/${userId}`, { method: "DELETE" })
      return { content: [{ type: "text", text: `✅ Bot ${userId} deactivated.` }] }
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
          serverInfo: { name: "mcp-zulip", version: "1.0.0" },
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
