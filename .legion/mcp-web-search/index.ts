#!/usr/bin/env bun

const respond = (id: number | string | null, result?: unknown, error?: unknown) => {
  const msg: Record<string, unknown> = { jsonrpc: "2.0" }
  if (id !== null) msg.id = id
  if (error) msg.error = error
  else msg.result = result
  process.stdout.write(JSON.stringify(msg) + "\n")
}
const log = (msg: string) => process.stderr.write(msg + "\n")

const DDG_SEARCH_URL = process.env.DDG_SEARCH_URL ?? "https://html.duckduckgo.com/html/"
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

async function duckDuckGoSearch(query: string, maxResults: number): Promise<string> {
  const body = new URLSearchParams({ q: query })
  const res = await fetch(DDG_SEARCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body,
  })
  const html = await res.text()

  const results: string[] = []
  const linkRegex = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
  const links: string[] = []
  const titles: string[] = []
  const snippets: string[] = []

  let m
  while ((m = linkRegex.exec(html)) !== null && links.length < maxResults) {
    links.push(m[1])
    titles.push(m[2].replace(/<[^>]+>/g, "").trim())
  }
  while ((m = snippetRegex.exec(html)) !== null && snippets.length < maxResults) {
    snippets.push(m[1].replace(/<[^>]+>/g, "").trim())
  }

  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    results.push(`${i + 1}. ${titles[i] ?? ""}\n   ${links[i] ?? ""}\n   ${snippets[i] ?? ""}`)
  }

  if (results.length === 0) return "No results found."
  return results.join("\n\n")
}

async function readUrl(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(15000),
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

  const maxLen = 10000
  if (text.length > maxLen) text = text.slice(0, maxLen) + "\n\n[...truncated]"

  return text || "No readable content found."
}

const tools = [
  {
    name: "web_search",
    description: "Search the web using DuckDuckGo. Returns results with title, URL, and snippet.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        max_results: { type: "number", description: "Max results (1-10)", default: 5 },
      },
      required: ["query"],
    },
  },
  {
    name: "read_url",
    description: "Fetch a URL and extract readable text content.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to read" },
      },
      required: ["url"],
    },
  },
]

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (name) {
    case "web_search": {
      const query = String(args.query ?? "")
      const maxResults = Math.min(Math.max(Number(args.max_results ?? 5), 1), 10)
      const text = await duckDuckGoSearch(query, maxResults)
      return { content: [{ type: "text", text }] }
    }
    case "read_url": {
      const url = String(args.url ?? "")
      const text = await readUrl(url)
      return { content: [{ type: "text", text }] }
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
      if (req.method === "initialize") respond(id, { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "mcp-web-search", version: "1.0.0" } })
      else if (req.method === "notifications/initialized") {}
      else if (req.method === "tools/list") respond(id, { tools })
      else if (req.method === "tools/call") {
        try { respond(id, await handleToolCall(req.params.name, req.params.arguments ?? {})) }
        catch (e: any) { respond(id, null, { code: -32000, message: e.message ?? String(e) }) }
      } else respond(id, null, { code: -32601, message: `Method not found: ${req.method}` })
    } catch (e: any) { log(`Parse error: ${e.message}`) }
  }
}
