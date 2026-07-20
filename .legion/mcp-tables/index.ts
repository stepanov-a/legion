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

const HELPER = path.join(import.meta.dir, "tables_helper.py")

function py(cmd: string, args: Record<string, unknown>): any {
  const input = JSON.stringify({ cmd, args })
  const out = execSync(`python3 "${HELPER}"`, { input, encoding: "utf-8", timeout: 30000 })
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
  const content = fs.readFileSync(localPath)
  await client.send(new PutObjectCommand({ Bucket: S3_BUCKET!, Key: key, Body: content }))
}

const tools = [
  {
    name: "read_table",
    description: "Read an Excel (.xlsx) or CSV file from S3 and return its contents as text",
    inputSchema: { type: "object", properties: {
      s3_key: { type: "string", description: "S3 key (e.g. tables/data.xlsx)" },
      sheet: { type: "string", description: "Sheet name (for .xlsx, optional)", default: "" },
      max_rows: { type: "integer", description: "Max rows to return", default: 50 },
    }, required: ["s3_key"] },
  },
  {
    name: "write_table",
    description: "Create an Excel (.xlsx) or CSV file from JSON data and upload to S3",
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "File name (without extension)" },
      format: { type: "string", description: '"xlsx" or "csv"', default: "xlsx" },
      headers: { type: "array", items: { type: "string" }, description: "Column headers" },
      rows: { type: "array", items: { type: "array", items: { type: "string" } }, description: "Data rows" },
    }, required: ["name", "headers", "rows"] },
  },
  {
    name: "transform_table",
    description: "Apply operations to a table (filter, sort, add column) and save to S3",
    inputSchema: { type: "object", properties: {
      s3_key: { type: "string", description: "Source S3 key" },
      operations: { type: "array", items: { type: "object" }, description: "List of operations" },
      output_name: { type: "string", description: "Output file name (without extension)" },
    }, required: ["s3_key", "operations", "output_name"] },
  },
  {
    name: "find_errors",
    description: "Analyze a table for common data quality issues",
    inputSchema: { type: "object", properties: {
      s3_key: { type: "string", description: "S3 key" },
    }, required: ["s3_key"] },
  },
]

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (name) {
    case "read_table": {
      const s3Key = String(args.s3_key ?? "")
      const sheet = String(args.sheet ?? "")
      const maxRows = Number(args.max_rows ?? 50)
      const localPath = await s3Download(s3Key)
      const result = py("read", { path: localPath, sheet, max_rows: maxRows })
      fs.unlinkSync(localPath)
      return { content: [{ type: "text", text: result.text }] }
    }

    case "write_table": {
      const name = String(args.name ?? "")
      const fmt = String(args.format ?? "xlsx")
      const headers = args.headers as string[]
      const rows = args.rows as string[][]
      const tmpPath = path.join("/tmp", `${name.replace(/[^a-zA-Z0-9_-]/g, "_")}.${fmt}`)
      py("write", { path: tmpPath, headers, rows })
      const s3Key = `tables/${name}.${fmt}`
      await s3Upload(tmpPath, s3Key)
      fs.unlinkSync(tmpPath)
      return { content: [{ type: "text", text: `✅ Таблица \`${s3Key}\` создана (${headers.length} колонок, ${rows.length} строк)` }] }
    }

    case "transform_table": {
      const s3Key = String(args.s3_key ?? "")
      const ops = args.operations as any[]
      const outName = String(args.output_name ?? "")
      const localPath = await s3Download(s3Key)
      const result = py("transform", { path: localPath, operations: ops, output_path: `/tmp/${outName}.xlsx` })
      const outKey = `tables/${outName}.xlsx`
      await s3Upload(result.output, outKey)
      fs.unlinkSync(localPath)
      fs.unlinkSync(result.output)
      return { content: [{ type: "text", text: result.text }] }
    }

    case "find_errors": {
      const s3Key = String(args.s3_key ?? "")
      const localPath = await s3Download(s3Key)
      const result = py("errors", { path: localPath })
      fs.unlinkSync(localPath)
      return { content: [{ type: "text", text: result.text }] }
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
      if (req.method === "initialize") respond(id, { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "mcp-tables", version: "1.0.0" } })
      else if (req.method === "notifications/initialized") {}
      else if (req.method === "tools/list") respond(id, { tools })
      else if (req.method === "tools/call") {
        try { respond(id, await handleToolCall(req.params.name, req.params.arguments ?? {})) }
        catch (e: any) { respond(id, null, { code: -32000, message: e.message ?? String(e) }) }
      } else respond(id, null, { code: -32601, message: `Method not found: ${req.method}` })
    } catch (e: any) { log(`Parse error: ${e.message}`) }
  }
}
