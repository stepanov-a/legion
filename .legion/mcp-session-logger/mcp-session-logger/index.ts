#!/usr/bin/env bun
import * as fs from "fs"
import * as path from "path"

const LEGION_DIR = process.env.LEGION_PROJECT_DIR
  ? path.join(process.env.LEGION_PROJECT_DIR, ".legion")
  : path.resolve(import.meta.dir, "..")
const LOG_DIR = path.join(LEGION_DIR, "logs", "sessions")

const RAGFLOW_API = process.env.RAGFLOW_API ?? "http://172.18.0.1:59380"
const RAGFLOW_TOKEN = process.env.RAGFLOW_TOKEN
const hasRagflow = !!RAGFLOW_API && !!RAGFLOW_TOKEN

const respond = (id: number | string | null, result?: unknown, error?: unknown) => {
  const msg: Record<string, unknown> = { jsonrpc: "2.0" }
  if (id !== null) msg.id = id
  if (error) msg.error = error
  else msg.result = result
  process.stdout.write(JSON.stringify(msg) + "\n")
}
const log = (msg: string) => process.stderr.write(msg + "\n")

function dateRange(days: number, since?: string, until?: string): string[] {
  const end = until ? new Date(until) : new Date()
  const start = since ? new Date(since) : new Date(end.getTime() - days * 86400000)
  if (since && !until) end.setDate(end.getDate() - 1) // skip today
  if (!since && !until) start.setDate(start.getDate() - days + 1)
  const dates: string[] = []
  const cur = new Date(start)
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10))
    cur.setDate(cur.getDate() + 1)
  }
  return dates.filter(d => d !== new Date().toISOString().slice(0, 10)) // skip today
}

function readLogFile(dateStr: string): any[] {
  const fp = path.join(LOG_DIR, `${dateStr}.jsonl`)
  if (!fs.existsSync(fp)) return []
  const lines = fs.readFileSync(fp, "utf-8").split("\n").filter(Boolean)
  const events: any[] = []
  for (const line of lines) {
    try { events.push(JSON.parse(line)) } catch {}
  }
  return events
}

function buildDigest(events: any[]): string {
  const sessions = new Map<string, any[]>()
  for (const ev of events) {
    const s = sessions.get(ev.s) || []
    s.push(ev)
    sessions.set(ev.s, s)
  }

  const lines: string[] = []
  for (const [sid, evts] of sessions) {
    const cmd = evts[0]?.cmd ?? "?"
    lines.push(`=== ${sid} (${cmd}) ===`)
    for (const ev of evts) {
      const t = (ev.t || "").slice(11, 19)
      switch (ev.e) {
        case "prompt_start":
          lines.push(`[${t}] prompt_start — len: ${ev.len}, mcp: ${ev.mcp}`)
          break
        case "llm_done":
          lines.push(`[${t}] llm_done — ${ev.ms}ms, hasResult: ${ev.hasResult}`)
          break
        case "done":
          lines.push(`[${t}] done — ${ev.ms}ms`)
          break
        case "error":
          lines.push(`[${t}] error — ${ev.msg}`)
          break
        default:
          lines.push(`[${t}] ${ev.e}${ev.ms ? ` — ${ev.ms}ms` : ""}`)
      }
    }
    lines.push("")
  }
  return lines.join("\n")
}

function buildStats(events: any[]): string {
  const sessions = new Set<string>()
  const cmdCount = new Map<string, number>()
  const cmdTime = new Map<string, number[]>()
  const errors: string[] = []
  let toolCalls = 0

  for (const ev of events) {
    sessions.add(ev.s)
    const c = ev.cmd || "?"
    cmdCount.set(c, (cmdCount.get(c) || 0) + 1)

    if (ev.e === "llm_done" && ev.ms) {
      const arr = cmdTime.get(c) || []
      arr.push(ev.ms)
      cmdTime.set(c, arr)
    }
    if (ev.e === "error" && ev.msg) errors.push(ev.msg)
    if (ev.e === "llm_done") toolCalls++
  }

  const lines: string[] = [`📊 Session stats (${sessions.size} sessions, ${events.length} events)`]
  lines.push("")
  lines.push("By command:")
  for (const [c, cnt] of cmdCount) {
    const times = cmdTime.get(c) || []
    const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : "-"
    const max = times.length ? Math.max(...times) : "-"
    lines.push(`  ${c}: ${cnt} sessions, avg ${avg}ms, max ${max}ms`)
  }

  if (errors.length) {
    lines.push("")
    lines.push(`Errors (${errors.length}):`)
    for (const msg of [...new Set(errors)].slice(0, 10)) lines.push(`  • ${msg}`)
  }

  return lines.join("\n")
}

const tools = [
  {
    name: "archive_sessions",
    description: "Archive session logs to RAGFlow for search. Creates one text file per day with session history.",
    inputSchema: {
      type: "object",
      properties: {
        dataset_name: { type: "string", description: "RAGFlow dataset name (default: session-history)", default: "session-history" },
        days: { type: "number", description: "Days to archive (default: 1, today excluded)", default: 1 },
        since: { type: "string", description: "Start date (ISO: 2026-07-01). Overrides days if set." },
        until: { type: "string", description: "End date (ISO: 2026-07-23). Defaults to yesterday." },
      },
      required: [],
    },
  },
  {
    name: "session_stats",
    description: "Session statistics for a period: counts, avg time, errors.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Lookback days (default: 7)", default: 7 },
        since: { type: "string", description: "Start date (ISO)" },
        until: { type: "string", description: "End date (ISO)" },
      },
      required: [],
    },
  },
]

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (name) {
    case "archive_sessions": {
      if (!hasRagflow) return { content: [{ type: "text", text: "❌ RAGFlow not configured (RAGFLOW_API / RAGFLOW_TOKEN not set)" }] }

      const datasetName = String(args.dataset_name ?? "session-history").trim()
      const days = Number(args.days ?? 1)
      const since = args.since ? String(args.since) : undefined
      const until = args.until ? String(args.until) : undefined
      const dates = dateRange(days, since, until)

      if (!dates.length) return { content: [{ type: "text", text: "No dates to archive (today excluded)." }] }

      const results: string[] = []
      for (const dateStr of dates) {
        const events = readLogFile(dateStr)
        if (!events.length) {
          results.push(`  ${dateStr}: no data`)
          continue
        }
        const digest = buildDigest(events)
        const fileName = `sessions-${dateStr}.txt`

        // Create dataset
        const dsRes = await fetch(`${RAGFLOW_API}/api/v1/datasets`, {
          method: "POST",
          headers: { Authorization: `Bearer ${RAGFLOW_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ name: datasetName }),
        })
        const dsBody = await dsRes.json()
        const dsId = dsBody.code !== 0
          ? (await (await fetch(`${RAGFLOW_API}/api/v1/datasets`, { headers: { Authorization: `Bearer ${RAGFLOW_TOKEN}` } })).json()).data?.docs?.find((d: any) => d.name === datasetName)?.id
          : Array.isArray(dsBody.data) ? dsBody.data[0]?.id : dsBody.data?.id
        if (!dsId) { results.push(`  ${dateStr}: failed to get/create dataset`); continue }

        // Upload
        const form = new FormData()
        form.append("file", new Blob([digest]), fileName)
        const upRes = await fetch(`${RAGFLOW_API}/api/v1/datasets/${dsId}/documents`, {
          method: "POST",
          headers: { Authorization: `Bearer ${RAGFLOW_TOKEN}` },
          body: form,
        })
        const upBody = await upRes.json()
        if (upBody.code !== 0) {
          results.push(`  ${dateStr}: upload failed (${upBody.message ?? "unknown"})`)
        } else {
          results.push(`  ${dateStr}: ${events.length} events, ${new Set(events.map(e => e.s)).size} sessions → uploaded`)
        }
      }

      return { content: [{ type: "text", text: `✅ Archive complete\nDataset: ${datasetName}\n${results.join("\n")}` }] }
    }

    case "session_stats": {
      const days = Number(args.days ?? 7)
      const since = args.since ? String(args.since) : undefined
      const until = args.until ? String(args.until) : undefined
      const dates = dateRange(days, since, until)

      let allEvents: any[] = []
      for (const dateStr of dates) {
        allEvents = allEvents.concat(readLogFile(dateStr))
      }

      if (!allEvents.length) return { content: [{ type: "text", text: "No session data for this period." }] }

      return { content: [{ type: "text", text: buildStats(allEvents) }] }
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
      if (req.method === "initialize") respond(id, { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "mcp-session-logger", version: "1.0.0" } })
      else if (req.method === "notifications/initialized") {}
      else if (req.method === "tools/list") respond(id, { tools })
      else if (req.method === "tools/call") {
        try { respond(id, await handleToolCall(req.params.name, req.params.arguments ?? {})) }
        catch (e: any) { respond(id, null, { code: -32000, message: e.message ?? String(e) }) }
      } else respond(id, null, { code: -32601, message: `Method not found: ${req.method}` })
    } catch (e: any) { log(`Parse error: ${e.message}`) }
  }
}
