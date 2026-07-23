#!/usr/bin/env bun

const DDG_SEARCH_URL = process.env.DDG_SEARCH_URL ?? "https://html.duckduckgo.com/html/"
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

const RAGFLOW_API = process.env.RAGFLOW_API
const RAGFLOW_TOKEN = process.env.RAGFLOW_TOKEN

async function searchWeb(query: string, maxResults: number): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const body = new URLSearchParams({ q: query })
  const res = await fetch(DDG_SEARCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body,
  })
  const html = await res.text()

  const linkRegex = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
  const results: Array<{ title: string; url: string; snippet: string }> = []
  const urls: string[] = []
  const titles: string[] = []
  const snippets: string[] = []

  let m
  while ((m = linkRegex.exec(html)) !== null && urls.length < maxResults) {
    urls.push(m[1]); titles.push(m[2].replace(/<[^>]+>/g, "").trim())
  }
  while ((m = snippetRegex.exec(html)) !== null && snippets.length < maxResults) {
    snippets.push(m[1].replace(/<[^>]+>/g, "").trim())
  }

  for (let i = 0; i < urls.length; i++) {
    results.push({ title: titles[i] ?? "", url: urls[i] ?? "", snippet: snippets[i] ?? "" })
  }
  return results
}

async function readUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10000),
    })
    const html = await res.text()
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/g, " ")
      .replace(/\s+/g, " ")
      .trim()
    if (text.length > 5000) text = text.slice(0, 5000) + "\n\n[...]"
    return text
  } catch {
    return "(failed to read)"
  }
}

async function searchRagflow(query: string, maxResults: number): Promise<Array<{ content: string; source: string; score: number }>> {
  if (!RAGFLOW_API || !RAGFLOW_TOKEN) return []
  try {
    const res = await fetch(`${RAGFLOW_API}/api/v1/retrieval`, {
      method: "POST",
      headers: { Authorization: `Bearer ${RAGFLOW_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ question: query, top_k: maxResults }),
      signal: AbortSignal.timeout(10000),
    })
    const json = await res.json()
    if (json.retcode !== 0) return []
    const chunks: Array<{ content: string; source: string; score: number }> = []
    for (const doc of json.data?.docs ?? []) {
      for (const chunk of doc.chunks ?? []) {
        chunks.push({ content: chunk.content ?? "", source: doc.doc_name ?? "unknown", score: chunk.similarity ?? 0 })
      }
    }
    return chunks.sort((a, b) => b.score - a.score).slice(0, maxResults)
  } catch {
    return []
  }
}

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
    name: "deep_research",
    description: "Deep research: searches the web and RAGFlow knowledge base, reads full content of top results, and returns structured findings. Use this instead of making multiple separate tool calls.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Research question or topic" },
        max_web_results: { type: "number", description: "Max web results to fetch (1-10)", default: 5 },
        read_content: { type: "boolean", description: "Fetch full content of each web result", default: true },
        include_ragflow: { type: "boolean", description: "Also search RAGFlow knowledge base", default: true },
        max_ragflow_chunks: { type: "number", description: "Max chunks from RAGFlow", default: 5 },
      },
      required: ["query"],
    },
  },
  {
    name: "deepen_research",
    description: "Deepen research on a specific finding or knowledge gap. Searches for more detail on a focused sub-topic.",
    inputSchema: {
      type: "object",
      properties: {
        focus: { type: "string", description: "Specific sub-topic or question to deepen" },
        context: { type: "string", description: "What we already know about this (optional)" },
        max_web_results: { type: "number", description: "Max results to fetch", default: 3 },
      },
      required: ["focus"],
    },
  },
]

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (name) {
    case "deep_research": {
      const query = String(args.query ?? "")
      const maxWeb = Math.min(Math.max(Number(args.max_web_results ?? 5), 1), 10)
      const readContent = args.read_content !== false
      const includeRagflow = args.include_ragflow !== false
      const maxRagflow = Math.min(Math.max(Number(args.max_ragflow_chunks ?? 5), 1), 20)

      const [webResults, ragflowChunks] = await Promise.all([
        searchWeb(query, maxWeb),
        includeRagflow ? searchRagflow(query, maxRagflow) : Promise.resolve([]),
      ])

      let content = `# Research: ${query}\n\n`

      if (webResults.length === 0 && ragflowChunks.length === 0) {
        content += "No results found from any source."
        return { content: [{ type: "text", text: content }] }
      }

      content += `## Web Search Results (${webResults.length})\n\n`
      for (let i = 0; i < webResults.length; i++) {
        const r = webResults[i]
        content += `### ${i + 1}. ${r.title}\n`
        content += `**URL:** ${r.url}\n`
        content += `**Snippet:** ${r.snippet}\n`
        if (readContent) {
          const body = await readUrl(r.url)
          content += `**Content:**\n${body}\n`
        }
        content += "\n"
      }

      if (ragflowChunks.length > 0) {
        content += `## RAGFlow Knowledge Base (${ragflowChunks.length} chunks)\n\n`
        for (const c of ragflowChunks) {
          content += `**Source:** ${c.source} (score: ${c.score.toFixed(3)})\n`
          content += `${c.content}\n\n`
        }
      }

      return { content: [{ type: "text", text: content }] }
    }

    case "deepen_research": {
      const focus = String(args.focus ?? "")
      const context = args.context ? String(args.context) : ""
      const maxWeb = Math.min(Math.max(Number(args.max_web_results ?? 3), 1), 10)

      const query = context ? `${focus} ${context.slice(0, 200)}` : focus
      const webResults = await searchWeb(query, maxWeb)

      let content = `# Deepen: ${focus}\n\n`

      if (webResults.length === 0) {
        content += "No additional results found."
        return { content: [{ type: "text", text: content }] }
      }

      for (let i = 0; i < webResults.length; i++) {
        const r = webResults[i]
        content += `### ${i + 1}. ${r.title}\n`
        content += `**URL:** ${r.url}\n`
        content += `**Snippet:** ${r.snippet}\n`
        const body = await readUrl(r.url)
        content += `**Content:**\n${body}\n\n`
      }

      return { content: [{ type: "text", text: content }] }
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

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
      if (req.method === "initialize") respond(id, { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "mcp-deep-research", version: "1.0.0" } })
      else if (req.method === "notifications/initialized") {}
      else if (req.method === "tools/list") respond(id, { tools })
      else if (req.method === "tools/call") {
        try { respond(id, await handleToolCall(req.params.name, req.params.arguments ?? {})) }
        catch (e: any) { respond(id, null, { code: -32000, message: e.message ?? String(e) }) }
      } else respond(id, null, { code: -32601, message: `Method not found: ${req.method}` })
    } catch (e: any) { log(`Parse error: ${e.message}`) }
  }
}
