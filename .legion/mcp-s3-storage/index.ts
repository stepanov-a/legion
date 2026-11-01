#!/usr/bin/env bun
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
const S3_ENDPOINT = process.env.S3_ENDPOINT
if (!S3_ENDPOINT) { console.error("S3_ENDPOINT is required"); process.exit(1) }
const S3_PUBLIC_ENDPOINT = process.env.S3_PUBLIC_ENDPOINT ?? S3_ENDPOINT.replace("host.docker.internal", "45.134.61.6")
const S3_REGION = process.env.S3_REGION ?? "us-east-1"
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY
if (!S3_ACCESS_KEY) { console.error("S3_ACCESS_KEY is required"); process.exit(1) }
const S3_SECRET_KEY = process.env.S3_SECRET_KEY
if (!S3_SECRET_KEY) { console.error("S3_SECRET_KEY is required"); process.exit(1) }
const S3_BUCKET = process.env.S3_BUCKET
if (!S3_BUCKET) { console.error("S3_BUCKET is required"); process.exit(1) }

const client = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  forcePathStyle: true,
})
const publicClient = S3_PUBLIC_ENDPOINT !== S3_ENDPOINT ? new S3Client({
  region: S3_REGION,
  endpoint: S3_PUBLIC_ENDPOINT,
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  forcePathStyle: true,
}) : client

// Zulip credentials for share links
const ZULIP_URL = process.env.ZULIP_URL
if (!ZULIP_URL) { console.error("ZULIP_URL is required"); process.exit(1) }
const ZULIP_EMAIL = process.env.ZULIP_EMAIL
if (!ZULIP_EMAIL) { console.error("ZULIP_EMAIL is required"); process.exit(1) }
const ZULIP_API_KEY = process.env.ZULIP_API_KEY
if (!ZULIP_API_KEY) { console.error("ZULIP_API_KEY is required"); process.exit(1) }
const ZULIP_HOST = process.env.ZULIP_API_HOST ?? ""
const zulipAuth = "Basic " + Buffer.from(`${ZULIP_EMAIL}:${ZULIP_API_KEY}`).toString("base64")
const ZULIP_EXTERNAL_URL = process.env.ZULIP_EXTERNAL_URL ?? `https://${ZULIP_HOST.replace(/:80$/, "")}`.replace(/\/+$/, "")

const log = (msg: string) => process.stderr.write(msg + "\n")

const respond = (id: number | string | null, result?: unknown, error?: unknown) => {
  const msg: Record<string, unknown> = { jsonrpc: "2.0" }
  if (id !== null) msg.id = id
  if (error) msg.error = error
  else msg.result = result
  process.stdout.write(JSON.stringify(msg) + "\n")
}

function sanitizePath(p: string): string {
  return p.replace(/\.\.(\/|\\)?/g, "_").replace(/\/+/g, "/").replace(/^\/+/, "").replace(/\0/g, "")
}

const tools = [
  {
    name: "write_file",
    description: "Write content to a file in S3 storage. Overwrites if exists.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path in bucket (e.g. reports/summary.md)" },
        content: { type: "string", description: "File content (text)" },
        content_type: { type: "string", description: "MIME type (optional)", default: "text/plain" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "read_file",
    description: "Read a file from S3 storage and return its content as text",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path in bucket" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description: "List files and directories under a prefix path",
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Path prefix (e.g. reports/ or empty for root)", default: "" },
        recursive: { type: "boolean", description: "List recursively into subdirectories", default: false },
      },
      required: [],
    },
  },
  {
    name: "move_file",
    description: "Move or rename a file within the bucket (copy + delete source)",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source file path" },
        target: { type: "string", description: "Target file path" },
      },
      required: ["source", "target"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file from S3 storage",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to delete" },
      },
      required: ["path"],
    },
  },
  {
    name: "get_share_link",
    description: "Generate a presigned URL for temporary file access (expires in seconds)",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path in bucket" },
        expiry: { type: "integer", description: "Expiry in seconds", default: 3600 },
        bot_email: { type: "string", description: "Your bot email to upload as yourself (required for users to be able to download)" },
      },
      required: ["path", "bot_email"],
    },
  },
]

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  const path = args.path ? sanitizePath(String(args.path)) : ""

  switch (name) {
    // ── write_file ────────────────────────────────────────────────────
    case "write_file": {
      const content = String(args.content ?? "")
      const contentType = String(args.content_type ?? "text/plain")
      await client.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: path,
        Body: content,
        ContentType: contentType,
      }))
      return { content: [{ type: "text", text: `✅ Written ${content.length} bytes to \`${path}\`. Teперь вызови get_share_link с path="${path}" чтобы получить ссылку для скачивания.` }] }
    }

    // ── read_file ─────────────────────────────────────────────────────
    case "read_file": {
      const res = await client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: path }))
      const text = await res.Body!.transformToString("utf-8")
      return { content: [{ type: "text", text }] }
    }

    // ── list_files ────────────────────────────────────────────────────
    case "list_files": {
      const prefix = String(args.prefix ?? "")
      const recursive = args.recursive === true
      const res = await client.send(new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: prefix,
        Delimiter: recursive ? undefined : "/",
      }))
      const lines: string[] = []
      for (const item of res.Contents ?? []) {
        if (item.Key === prefix) continue
        lines.push(`📄 ${item.Key}  (${item.Size} bytes, ${item.LastModified?.toISOString().slice(0, 10)})`)
      }
      for (const item of res.CommonPrefixes ?? []) {
        lines.push(`📁 ${item.Prefix}/`)
      }
      return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "(empty)" }] }
    }

    // ── move_file ─────────────────────────────────────────────────────
    case "move_file": {
      const source = sanitizePath(String(args.source ?? ""))
      const target = sanitizePath(String(args.target ?? ""))
      await client.send(new CopyObjectCommand({
        Bucket: S3_BUCKET,
        CopySource: `/${S3_BUCKET}/${source}`,
        Key: target,
      }))
      await client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: source }))
      return { content: [{ type: "text", text: `✅ Moved \`${source}\` → \`${target}\`` }] }
    }

    // ── delete_file ───────────────────────────────────────────────────
    case "delete_file": {
      await client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: path }))
      return { content: [{ type: "text", text: `✅ Deleted \`${path}\`` }] }
    }

    // ── get_share_link ────────────────────────────────────────────────
    case "get_share_link": {
      const fileName = path.split("/").pop() ?? "file"
      const ext = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() : ""
      const viewableTypes = ["html", "htm", "pdf", "svg", "txt", "md"]

      // For viewable files (HTML, PDF) use S3 presigned URL with attachment
      if (viewableTypes.includes(ext ?? "")) {
        const expiry = Number(args.expiry ?? 604800)
        const getCmd = new GetObjectCommand({
          Bucket: S3_BUCKET,
          Key: path,
          ResponseContentDisposition: `attachment; filename="${fileName}"`,
        })
        const link = await getSignedUrl(client, getCmd, { expiresIn: expiry })
        return { content: [{ type: "text", text: link }] }
      }

      // For binary files (PPTX, XLSX, etc.) upload to Zulip
      const obj = await client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: path }))
      const buf = await obj.Body!.transformToByteArray()
      const botEmail = args.bot_email ? String(args.bot_email) : ""

      let auth = zulipAuth
      if (botEmail) {
        const botsPath = "/legion/.legion/bots.jsonc"
        try {
          const raw = JSON.parse(require("fs").readFileSync(botsPath, "utf-8"))
          const bot = (raw.bots ?? []).find((b: any) => b.zulip_email === botEmail)
          if (bot?.zulip_api_key) {
            auth = "Basic " + Buffer.from(`${botEmail}:${bot.zulip_api_key}`).toString("base64")
          }
        } catch {}
      }

      const form = new FormData()
      form.append("file", new Blob([buf]), fileName)
      const res = await fetch(`${ZULIP_URL}/api/v1/user_uploads`, {
        method: "POST",
        headers: { Authorization: auth, Host: ZULIP_HOST },
        body: form,
      })
      if (!res.ok) {
        const err = await res.text().catch(() => "")
        throw new Error(`Upload failed (HTTP ${res.status}): ${err.substring(0, 200)}`)
      }
      const json = await res.json()
      if (json.result !== "success") throw new Error(json.msg ?? "Upload to Zulip failed")

      const uri = decodeURIComponent(json.uri)
      const host = ZULIP_EXTERNAL_URL.replace(/\/+$/, "")
      const link = uri.startsWith("http") ? uri : `${host}${uri.startsWith("/") ? "" : "/"}${uri}`
      return { content: [{ type: "text", text: link }] }
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
          serverInfo: { name: "mcp-s3-storage", version: "1.0.0" },
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
