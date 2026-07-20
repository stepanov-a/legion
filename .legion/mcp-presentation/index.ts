#!/usr/bin/env bun
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import { execSync } from "child_process"
import * as path from "path"
import * as fs from "fs"

// ── ENV ──────────────────────────────────────────────────────────
const S3_ENDPOINT = process.env.S3_ENDPOINT
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY
const S3_SECRET_KEY = process.env.S3_SECRET_KEY
const S3_BUCKET = process.env.S3_BUCKET
const S3_REGION = process.env.S3_REGION ?? "us-east-1"

if (!S3_ENDPOINT || !S3_ACCESS_KEY || !S3_SECRET_KEY || !S3_BUCKET) {
  console.error("S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET are required")
  process.exit(1)
}

const client = new S3Client({
  region: S3_REGION, endpoint: S3_ENDPOINT,
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  forcePathStyle: true,
})

const PYTHON_HELPER = path.join(import.meta.dir, "pptx_helper.py")

function py(cmd: string, args: Record<string, unknown>): any {
  const input = JSON.stringify({ cmd, args })
  const out = execSync(`python3 "${PYTHON_HELPER}"`, { input, encoding: "utf-8", timeout: 30000 })
  const result = JSON.parse(out.trim())
  if (result.error) throw new Error(result.error)
  return result
}

// ── MCP helpers ──────────────────────────────────────────────────
const respond = (id: number | string | null, result?: unknown, error?: unknown) => {
  const msg: Record<string, unknown> = { jsonrpc: "2.0" }
  if (id !== null) msg.id = id
  if (error) msg.error = error
  else msg.result = result
  process.stdout.write(JSON.stringify(msg) + "\n")
}
const log = (msg: string) => process.stderr.write(msg + "\n")

const tools = [
  {
    name: "create_presentation",
    description: "Create a new PPTX presentation from a list of slides",
    inputSchema: {
      type: "object", properties: {
        name: { type: "string", description: "File name (without .pptx)" },
        title: { type: "string", description: "Presentation title", default: "Presentation" },
        slides: {
          type: "array", description: "Array of slides",
          items: {
            type: "object", properties: {
              title: { type: "string", description: "Slide title" },
              content: { type: "string", description: "Slide content (paragraphs separated by newlines)" },
            }, required: ["title"],
          },
        },
      }, required: ["name", "slides"],
    },
  },
  {
    name: "analyze_presentation",
    description: "Analyze an existing PPTX from S3 — list slides and their content",
    inputSchema: {
      type: "object", properties: {
        s3_key: { type: "string", description: "S3 key (e.g. presentations/my.pptx)" },
      }, required: ["s3_key"],
    },
  },
  {
    name: "update_slide",
    description: "Replace content of a specific slide in an existing PPTX on S3",
    inputSchema: {
      type: "object", properties: {
        s3_key: { type: "string", description: "S3 key" },
        slide_number: { type: "integer", description: "Slide number (1-based)" },
        content: { type: "string", description: "New slide content" },
      }, required: ["s3_key", "slide_number", "content"],
    },
  },
  {
    name: "convert_to_pdf",
    description: "Convert a PPTX from S3 to PDF using LibreOffice",
    inputSchema: {
      type: "object", properties: {
        s3_key: { type: "string", description: "S3 key" },
      }, required: ["s3_key"],
    },
  },
]

async function s3Download(key: string): Promise<string> {
  const tmp = path.join("/tmp", path.basename(key))
  const res = await client.send(new GetObjectCommand({ Bucket: S3_BUCKET!, Key: key }))
  const buf = await res.Body!.transformToByteArray()
  fs.writeFileSync(tmp, Buffer.from(buf))
  return tmp
}

async function s3Upload(localPath: string, key: string): Promise<void> {
  const content = fs.readFileSync(localPath)
  await client.send(new PutObjectCommand({ Bucket: S3_BUCKET!, Key: key, Body: content }))
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (name) {
    case "create_presentation": {
      const name = String(args.name ?? "")
      const title = String(args.title ?? "Presentation")
      const slides = args.slides as Array<Record<string, string>>

      const tmpPath = path.join("/tmp", `${name.replace(/[^a-zA-Z0-9_-]/g, "_")}.pptx`)
      py("create", { path: tmpPath, title, slides })

      const s3Key = `presentations/${name}.pptx`
      await s3Upload(tmpPath, s3Key)
      fs.unlinkSync(tmpPath)

      return { content: [{ type: "text", text: [
        `✅ Презентация "${title}" создана.`,
        `**Файл:** \`${s3Key}\``,
        `**Слайдов:** ${slides.length}`,
        `**S3 URI:** s3://${S3_BUCKET}/${s3Key}`,
      ].join("\n") }] }
    }

    case "analyze_presentation": {
      const s3Key = String(args.s3_key ?? "")
      const localPath = await s3Download(s3Key)
      const result = py("analyze", { path: localPath })
      fs.unlinkSync(localPath)

      const props = result.properties
      const slides = (result.slides as any[]).map((s: any) => {
        const texts = s.shapes.filter((sh: any) => sh.text).map((sh: any) => sh.text).join(" | ")
        return `  ${s.number}. ${texts.slice(0, 200)}`
      }).join("\n")

      return { content: [{ type: "text", text: [
        `**Презентация:** ${s3Key}`,
        `**Слайдов:** ${props.slide_count}`,
        `**Размер:** ${props.slide_width}x${props.slide_height}`,
        `**Содержимое:**`,
        slides || "  (пусто)",
      ].join("\n") }] }
    }

    case "update_slide": {
      const s3Key = String(args.s3_key ?? "")
      const slideNumber = Number(args.slide_number ?? 0)
      const content = String(args.content ?? "")

      const localPath = await s3Download(s3Key)
      py("update_slide", { path: localPath, slide_number: slideNumber, content })
      await s3Upload(localPath, s3Key)
      fs.unlinkSync(localPath)

      return { content: [{ type: "text", text: `✅ Слайд ${slideNumber} обновлён в \`${s3Key}\`` }] }
    }

    case "convert_to_pdf": {
      const s3Key = String(args.s3_key ?? "")
      const localPath = await s3Download(s3Key)

      const result = py("convert_to_pdf", { path: localPath, output_dir: "/tmp" })
      const pdfLocal = result.pdf_path
      const pdfKey = s3Key.replace(/\.pptx$/i, ".pdf")
      await s3Upload(pdfLocal, pdfKey)
      fs.unlinkSync(localPath)
      fs.unlinkSync(pdfLocal)

      return { content: [{ type: "text", text: [
        `✅ PDF создан.`,
        `**S3 URI:** s3://${S3_BUCKET}/${pdfKey}`,
      ].join("\n") }] }
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
          serverInfo: { name: "mcp-presentation", version: "1.0.0" },
        })
      } else if (req.method === "notifications/initialized") {
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
