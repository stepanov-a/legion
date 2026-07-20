#!/usr/bin/env bun
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import { execSync } from "child_process"
import * as path from "path"
import * as fs from "fs"

const S3_ENDPOINT = process.env.S3_ENDPOINT
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY
const S3_SECRET_KEY = process.env.S3_SECRET_KEY
const S3_BUCKET = process.env.S3_BUCKET
const S3_REGION = process.env.S3_REGION ?? "us-east-1"
if (!S3_ENDPOINT || !S3_ACCESS_KEY || !S3_SECRET_KEY || !S3_BUCKET) {
  console.error("S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET are required"); process.exit(1)
}

const client = new S3Client({
  region: S3_REGION, endpoint: S3_ENDPOINT,
  credentials: { accessKeyId: S3_ACCESS_KEY!, secretAccessKey: S3_SECRET_KEY! },
  forcePathStyle: true,
})

const HELPER = path.join(import.meta.dir, "media_helper.py")

function py(cmd: string, args: Record<string, unknown>): any {
  const input = JSON.stringify({ cmd, args })
  const out = execSync(`python3 "${HELPER}"`, { input, encoding: "utf-8", timeout: 60000 })
  const result = JSON.parse(out.trim())
  if (result.error) throw new Error(result.error)
  return result
}

const respond = (id: number | string | null, result?: unknown, error?: unknown) => {
  const msg: Record<string, unknown> = { jsonrpc: "2.0" }
  if (id !== null) msg.id = id
  if (error) msg.error = error
  else msg.result = result
  process.stdout.write(JSON.stringify(msg) + "\n")
}
const log = (msg: string) => process.stderr.write(msg + "\n")

async function s3Download(key: string): Promise<string> {
  const tmp = path.join("/tmp", path.basename(key))
  const res = await client.send(new GetObjectCommand({ Bucket: S3_BUCKET!, Key: key }))
  fs.writeFileSync(tmp, Buffer.from(await res.Body!.transformToByteArray()))
  return tmp
}
async function s3Upload(localPath: string, key: string): Promise<void> {
  await client.send(new PutObjectCommand({ Bucket: S3_BUCKET!, Key: key, Body: fs.readFileSync(localPath) }))
}

const tools = [
  {
    name: "analyze_media",
    description: "Analyze a media file (audio, video, image) from S3 — get format, duration, dimensions, metadata",
    inputSchema: { type: "object", properties: {
      s3_key: { type: "string", description: "S3 key of the media file" },
    }, required: ["s3_key"] },
  },
  {
    name: "extract_audio",
    description: "Extract audio track from a video file and save as MP3 to S3",
    inputSchema: { type: "object", properties: {
      s3_key: { type: "string", description: "S3 key of the video" },
      output_name: { type: "string", description: "Output file name (without extension)" },
    }, required: ["s3_key", "output_name"] },
  },
  {
    name: "generate_image",
    description: "Generate a simple image with text/lines using Pillow and upload to S3",
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "Output file name (without extension)" },
      text: { type: "string", description: "Text to render on the image" },
      width: { type: "integer", description: "Image width", default: 800 },
      height: { type: "integer", description: "Image height", default: 400 },
      color: { type: "string", description: "Background color (name or hex)", default: "#2c3e50" },
    }, required: ["name", "text"] },
  },
  {
    name: "extract_metadata",
    description: "Extract metadata from a media file (audio/video/image) — tags, EXIF, codec info",
    inputSchema: { type: "object", properties: {
      s3_key: { type: "string", description: "S3 key" },
    }, required: ["s3_key"] },
  },
]

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (name) {
    case "analyze_media": {
      const s3Key = String(args.s3_key ?? "")
      const localPath = await s3Download(s3Key)
      const result = py("analyze", { path: localPath })
      fs.unlinkSync(localPath)
      const lines = Object.entries(result).map(([k, v]) => `  ${k}: ${v}`).join("\n")
      return { content: [{ type: "text", text: `**${path.basename(s3Key)}**\n${lines}` }] }
    }

    case "extract_audio": {
      const s3Key = String(args.s3_key ?? "")
      const outName = String(args.output_name ?? "")
      const localPath = await s3Download(s3Key)
      const outPath = path.join("/tmp", `${outName}.mp3`)
      py("extract_audio", { path: localPath, output: outPath })
      const s3OutKey = `media/${outName}.mp3`
      await s3Upload(outPath, s3OutKey)
      fs.unlinkSync(localPath); fs.unlinkSync(outPath)
      return { content: [{ type: "text", text: `✅ Audio extracted → \`${s3OutKey}\`` }] }
    }

    case "generate_image": {
      const name = String(args.name ?? "")
      const text = String(args.text ?? "")
      const width = Number(args.width ?? 800)
      const height = Number(args.height ?? 400)
      const color = String(args.color ?? "#2c3e50")
      const outPath = path.join("/tmp", `${name}.png`)
      py("generate_image", { path: outPath, text, width, height, color })
      const s3Key = `media/${name}.png`
      await s3Upload(outPath, s3Key)
      fs.unlinkSync(outPath)
      return { content: [{ type: "text", text: `✅ Image generated → \`${s3Key}\` (${width}x${height})` }] }
    }

    case "extract_metadata": {
      const s3Key = String(args.s3_key ?? "")
      const localPath = await s3Download(s3Key)
      const result = py("metadata", { path: localPath })
      fs.unlinkSync(localPath)
      const lines = Object.entries(result).map(([k, v]) => `  ${k}: ${v}`).join("\n")
      return { content: [{ type: "text", text: `**${path.basename(s3Key)}**\n${lines}` }] }
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
      if (req.method === "initialize") respond(id, { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "mcp-media", version: "1.0.0" } })
      else if (req.method === "notifications/initialized") {}
      else if (req.method === "tools/list") respond(id, { tools })
      else if (req.method === "tools/call") {
        try { respond(id, await handleToolCall(req.params.name, req.params.arguments ?? {})) }
        catch (e: any) { respond(id, null, { code: -32000, message: e.message ?? String(e) }) }
      } else respond(id, null, { code: -32601, message: `Method not found: ${req.method}` })
    } catch (e: any) { log(`Parse error: ${e.message}`) }
  }
}
