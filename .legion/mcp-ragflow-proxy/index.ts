#!/usr/bin/env bun
const RAGFLOW_API = process.env.RAGFLOW_API ?? "http://127.0.0.1:9380"
const TOKEN = process.env.RAGFLOW_TOKEN
if (!TOKEN) { console.error("RAGFLOW_TOKEN is required"); process.exit(1) }

// LLM provider config (for build_cards)
const LLM_PROVIDER = process.env.LLM_PROVIDER ?? "ollama"
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "http://localhost:11434"
const LLM_MODEL = process.env.LLM_MODEL ?? "hf.co/yuxinlu1/gemma-4-12B-coder-fable5-composer2.5-v1-GGUF:Q8_0"
const LLM_API_KEY = process.env.LLM_API_KEY ?? ""

const api = (path: string, init?: RequestInit) =>
  fetch(`${RAGFLOW_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...init?.headers },
  })

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

const tools = [
  {
    name: "list_datasets",
    description: "List all available RAGFlow datasets/knowledge bases with their metadata",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_documents",
    description: "List documents inside a specific dataset",
    inputSchema: {
      type: "object",
      properties: {
        dataset_id: { type: "string", description: "Dataset ID" },
        page: { type: "integer", description: "Page number", default: 1 },
        page_size: { type: "integer", description: "Results per page", default: 30 },
      },
      required: ["dataset_id"],
    },
  },
  {
    name: "get_document",
    description: "Get/download a document. Returns document metadata and a download URL for the original file",
    inputSchema: {
      type: "object",
      properties: {
        dataset_id: { type: "string", description: "Dataset ID" },
        document_id: { type: "string", description: "Document ID" },
      },
      required: ["dataset_id", "document_id"],
    },
  },
  {
    name: "get_chunks",
    description: "Get text chunks of a document with their content",
    inputSchema: {
      type: "object",
      properties: {
        dataset_id: { type: "string", description: "Dataset ID" },
        document_id: { type: "string", description: "Document ID" },
        page: { type: "integer", description: "Page number", default: 1 },
        page_size: { type: "integer", description: "Results per page", default: 100 },
      },
      required: ["dataset_id", "document_id"],
    },
  },
  {
    name: "get_chunk",
    description: "Get a specific chunk by its ID with full content and metadata",
    inputSchema: {
      type: "object",
      properties: {
        dataset_id: { type: "string", description: "Dataset ID" },
        document_id: { type: "string", description: "Document ID" },
        chunk_id: { type: "string", description: "Chunk ID" },
      },
      required: ["dataset_id", "document_id", "chunk_id"],
    },
  },
  {
    name: "search_retrieval",
    description: "Search across datasets using semantic retrieval. Returns relevant chunks ranked by similarity. Replaces the built-in ragflow_retrieval",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Search query" },
        dataset_ids: {
          type: "array", items: { type: "string" },
          description: "Optional dataset IDs to restrict search. If omitted, searches all datasets",
        },
        page: { type: "integer", default: 1 },
        page_size: { type: "integer", default: 10 },
        similarity_threshold: { type: "number", default: 0.2 },
        vector_similarity_weight: { type: "number", default: 0.3 },
        top_k: { type: "integer", default: 1024 },
        keyword: { type: "boolean", default: false },
      },
      required: ["question"],
    },
  },
  {
    name: "upload_document",
    description: "Upload a new document to a dataset. Provide either a URL to fetch the document from, or text content directly",
    inputSchema: {
      type: "object",
      properties: {
        dataset_id: { type: "string", description: "Dataset ID" },
        file_name: { type: "string", description: "Document file name" },
        file_url: { type: "string", description: "URL to fetch the document from (optional if text_content is provided)" },
        text_content: { type: "string", description: "Raw text content (optional if file_url is provided)" },
      },
      required: ["dataset_id", "file_name"],
    },
  },
  {
    name: "chat_completion",
    description: "Chat with a RAGFlow assistant/chatbot. Requires a chat_id (assistant ID from the RAGFlow UI)",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Chat assistant ID" },
        question: { type: "string", description: "User message" },
        stream: { type: "boolean", default: false },
      },
      required: ["chat_id", "question"],
    },
  },
  {
    name: "list_chats",
    description: "List available chat assistants configured in RAGFlow",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
    {
    name: "build_cards",
    description: "Build structured entity cards from wiki export using an LLM. Phase 1: LLM extracts entities per dataset. Phase 2: finds relevant chunks. Phase 3: generates formatted cards with [[EntityName]] notation for Obsidian graph",
      inputSchema: {
        type: "object",
        properties: {
          wiki_dir: { type: "string", description: "Path to wiki markdown files (default: .legion/pipeline-execution/wiki/)" },
          output_dir: { type: "string", description: "Output directory for cards (default: .legion/pipeline-execution/cards/)" },
          entity_limit: { type: "integer", default: 30, description: "Max entities to process" },
          chunks_per_entity: { type: "integer", default: 15, description: "Max chunks to include per entity card" },
          provider: { type: "string", default: LLM_PROVIDER, description: "LLM provider: ollama, openai, openai-compatible" },
          base_url: { type: "string", default: LLM_BASE_URL, description: "LLM API base URL" },
          model: { type: "string", default: LLM_MODEL, description: "Model name" },
          api_key: { type: "string", default: LLM_API_KEY, description: "API key (if required)" },
        },
        required: [],
      },
    },
    {
      name: "export_wiki",
    description: "Export all chunks as markdown files (one file per document) with frontmatter metadata. No entity extraction — that is handled by build_cards via LLM",
    inputSchema: {
      type: "object",
      properties: {
        dataset_ids: { type: "array", items: { type: "string" }, description: "Restrict to specific dataset IDs. If omitted, exports all datasets" },
        output_dir: { type: "string", description: "Output directory (default: .legion/pipeline-execution/wiki/)" },
        max_chunks_per_doc: { type: "integer", default: 0, description: "Max chunks per document (0 = all)" },
      },
      required: [],
    },
  },
]

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "list_datasets": {
      const res = await api("/api/v1/datasets")
      const body = await res.json()
      if (body.code !== 0) throw new Error(body.message)
      return { content: [{ type: "text", text: formatDatasets(body.data) }] }
    }
    case "list_documents": {
      const { dataset_id, page = 1, page_size = 30 } = args as any
      const res = await api(`/api/v1/datasets/${dataset_id}/documents?page=${page}&page_size=${page_size}`)
      const body = await res.json()
      if (body.code !== 0) throw new Error(body.message)
      return { content: [{ type: "text", text: formatDocuments(body.data) }] }
    }
    case "get_document": {
      const { dataset_id, document_id } = args as any
      const res = await api(`/api/v1/datasets/${dataset_id}/documents/${document_id}`)
      const body = await res.json()
      if (body.code !== 0) throw new Error(body.message)
      return { content: [{ type: "text", text: JSON.stringify(body.data, null, 2) }] }
    }
    case "get_chunks": {
      const { dataset_id, document_id, page = 1, page_size = 100 } = args as any
      const res = await api(`/api/v1/datasets/${dataset_id}/documents/${document_id}/chunks?page=${page}&page_size=${page_size}`)
      const body = await res.json()
      if (body.code !== 0) throw new Error(body.message)
      return { content: [{ type: "text", text: formatChunks(body.data) }] }
    }
    case "get_chunk": {
      const { dataset_id, document_id, chunk_id } = args as any
      const res = await api(`/api/v1/datasets/${dataset_id}/documents/${document_id}/chunks/${chunk_id}`)
      const body = await res.json()
      if (body.code !== 0) throw new Error(body.message)
      return { content: [{ type: "text", text: JSON.stringify(body.data, null, 2) }] }
    }
    case "search_retrieval": {
      const { dataset_ids, question, page = 1, page_size = 10, similarity_threshold = 0.2, vector_similarity_weight = 0.3, top_k = 1024, keyword = false } = args as any
      const payload: any = { question, page, page_size, similarity_threshold, vector_similarity_weight, top_k, keyword }
      if (dataset_ids?.length) payload.dataset_ids = dataset_ids

      // Use the RAGFlow retrieval endpoint
      const res = await api("/api/v1/retrieval", { method: "POST", body: JSON.stringify(payload) })
      const body = await res.json()
      if (body.code !== 0) throw new Error(body.message)
      return { content: [{ type: "text", text: formatRetrievalResults(body.data) }] }
    }
    case "upload_document": {
      const { dataset_id, file_name, file_url, text_content } = args as any
      const res = await api(`/api/v1/datasets/${dataset_id}/documents`, {
        method: "POST",
        body: JSON.stringify({ file_name, ...(file_url ? { url: file_url } : {}), ...(text_content ? { text_content } : {}) }),
      })
      const body = await res.json()
      if (body.code !== 0) throw new Error(body.message)
      return { content: [{ type: "text", text: JSON.stringify(body.data, null, 2) }] }
    }
    case "chat_completion": {
      const { chat_id, question, stream = false } = args as any
      const res = await api(`/api/v1/chats/${chat_id}/completions`, {
        method: "POST",
        body: JSON.stringify({ question, stream }),
      })
      const body = await res.json()
      if (body.code !== 0) throw new Error(body.message)
      return { content: [{ type: "text", text: body.data.answer ?? JSON.stringify(body.data, null, 2) }] }
    }
    case "list_chats": {
      const res = await api("/api/v1/chats")
      const body = await res.json()
      if (body.code !== 0) throw new Error(body.message)
      return { content: [{ type: "text", text: formatChats(body.data) }] }
    }
    case "export_wiki": {
      return await handleExportWiki(args as any)
    }
    case "build_cards": {
      return await handleBuildCards(args as any)
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

function formatDatasets(data: any[]): string {
  if (!data?.length) return "No datasets found."
  const rows = data.map((d: any) =>
    `${d.id} | ${d.name} | docs=${d.document_count ?? d.doc_num} | chunks=${d.chunk_count ?? d.chunk_num} | ${d.chunk_method ?? d.parser_id}`
  )
  return `Datasets (${data.length}):\n\nID | Name | Documents | Chunks | Parser\n--|--|--|--|--\n${rows.join("\n")}`
}

function formatDocuments(data: any[]): string {
  if (!data?.length) return "No documents found."
  const rows = data.map((d: any) =>
    `${d.id} | ${d.name} | status=${d.status} | chunks=${d.chunk_num ?? d.chunk_count} | size=${d.size ?? "-"}`
  )
  return `Documents (${data.length}):\n\nID | Name | Status | Chunks | Size\n--|--|--|--|--\n${rows.join("\n")}`
}

function formatChunks(data: any[]): string {
  if (!data?.length) return "No chunks found."
  return data.map((c: any, i: number) =>
    `[${i + 1}] id=${c.id}\n${c.content ?? c.text ?? "(no content)"}\n`
  ).join("\n---\n")
}

function formatRetrievalResults(data: any): string {
  if (!data) return "No results."
  const chunks = data.chunks ?? data ?? []
  if (!chunks.length) return "No relevant chunks found."
  return chunks.map((c: any, i: number) => {
    const src = c.dataset_name ?? c.dataset_id ?? ""
    const score = c.similarity ?? c.score ?? ""
    return `[${i + 1}] (score: ${score}, source: ${src})\n${c.content ?? c.text ?? ""}`
  }).join("\n\n---\n\n")
}

function formatChats(data: any[]): string {
  if (!data?.length) return "No chat assistants found."
  return data.map((c: any) => `${c.id} | ${c.name} | ${c.description ?? ""}`).join("\n")
}

// ── Wiki export ──────────────────────────────────────────
async function fetchItems(baseUrl: string, dataKey: string, pageSize = 100): Promise<any[]> {
  const all: any[] = []
  let page = 1
  for (let i = 0; i < 50; i++) {
    const sep = baseUrl.includes("?") ? "&" : "?"
    const res = await api(`${baseUrl}${sep}page=${page}&page_size=${pageSize}`)
    const body = await res.json()
    const items = body.data?.[dataKey] ?? []
    if (!items.length) break
    all.push(...items)
    if (items.length < pageSize) break
    page++
  }
  return all
}

// Entity extraction is handled by LLM in build_cards.
// No regex-based extraction — OCR text produces too much noise.

const CONCURRENCY = 32

async function concurrentMap<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency = CONCURRENCY, timeoutMs?: number): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency)
    const batchResults = await Promise.allSettled(
      batch.map(item => {
        const task = fn(item)
        if (timeoutMs) {
          return Promise.race([
            task,
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs))
          ])
        }
        return task
      })
    )
    for (const r of batchResults) {
      if (r.status === "rejected") log(`Concurrent task failed: ${r.reason}`)
      else results.push(r.value)
    }
  }
  return results
}

async function handleExportWiki(args: { dataset_ids?: string[]; output_dir?: string; max_chunks_per_doc?: number }): Promise<unknown> {
  const outputDir = args.output_dir ?? `${import.meta.dir}/../pipeline-execution/wiki`
  const dsRes = await api("/api/v1/datasets")
  const dsBody = await dsRes.json()
  let datasets: any[] = dsBody.data ?? []
  if (args.dataset_ids?.length) datasets = datasets.filter((d: any) => args.dataset_ids!.includes(d.id))

  await Bun.$`mkdir -p ${outputDir}`.quiet()

  interface Chunk { dataset: string; doc: string; content: string; id: string }

  // Phase 1: fetch all documents for all datasets in parallel
  const allDocs = await concurrentMap(datasets, async (ds) => {
    const docs = await fetchItems(`/api/v1/datasets/${ds.id}/documents`, "docs")
    return docs.map((d: any) => ({ ...d, datasetId: ds.id, datasetName: ds.name }))
  })
  const docs = allDocs.flat()

  // Phase 2: fetch all chunks for all documents in parallel
  const maxChunks = args.max_chunks_per_doc ?? 0
  const allChunkResults = await concurrentMap(docs, async (doc) => {
    const chunks = await fetchItems(`/api/v1/datasets/${doc.datasetId}/documents/${doc.id}/chunks`, "chunks")
    const sliced = maxChunks > 0 ? chunks.slice(0, maxChunks) : chunks
    return sliced.map((c: any) => ({
      dataset: doc.datasetName, doc: doc.name, content: c.content ?? c.text ?? "", id: c.id
    }))
  })
  let allChunks = allChunkResults.flat()

  // Exact dedup by content hash
  const seenHashes = new Set<string>()
  const hash = (s: string) => {
    let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0 }
    return h
  }
  allChunks = allChunks.filter(c => {
    const h = hash(c.content)
    if (seenHashes.has(h)) return false
    seenHashes.add(h)
    return true
  })

  // Near-exact dedup: normalize and compare prefix signatures
  const normSig = (s: string) => s.toLowerCase().replace(/[^a-zа-яё0-9]/g, "").slice(0, 80)
  const seenSigs = new Set<string>()
  allChunks = allChunks.filter(c => {
    const sig = normSig(c.content)
    if (seenSigs.has(sig)) return false
    seenSigs.add(sig)
    return true
  })

  log(`Collected ${allChunks.length} unique chunks from ${docs.length} documents`)

  // Phase 3: write one file per document
  const byDoc = new Map<string, { dataset: string; docName: string; chunks: Chunk[] }>()
  for (const c of allChunks) {
    const key = `${c.dataset}::${c.doc}`
    const existing = byDoc.get(key)
    if (existing) existing.chunks.push(c)
    else byDoc.set(key, { dataset: c.dataset, docName: c.doc, chunks: [c] })
  }

  const writeTasks = [...byDoc.entries()].map(([key, { dataset, docName, chunks }]) => {
    const isTabular = /\.xlsx?$/i.test(docName)
    const lines: string[] = []
    lines.push(`---`, `dataset: "${dataset}"`, `document: "${docName}"`, `chunks: ${chunks.length}`, `type: ${isTabular ? "tabular" : "text"}`, `---`, ``)
    lines.push(`# ${docName}`, ``, `*Датасет: ${dataset}*`, ``)
    if (isTabular) lines.push(`*Тип: табличные данные (Excel). Каждая строка — отдельная запись.*`, ``)

    for (const c of chunks) {
      lines.push(c.content, ``, `*Чанк: \`${c.id}\`*`, ``)
      if (c !== chunks[chunks.length - 1]) lines.push(`---`, ``)
    }

    const safeName = key.replace(/[/\\:]/g, "_").slice(0, 200)
    const filePath = `${outputDir}/${safeName}.md`
    return Bun.write(filePath, lines.join("\n")).then(() => filePath)
  })

  const wikiFiles = await Promise.all(writeTasks)

  const summary = [
    `# LLM-Wiki Export Summary`,
    ``,
    `- **Datasets**: ${datasets.length}`,
    `- **Documents**: ${docs.length}`,
    `- **Chunks**: ${allChunks.length}`,
    `- **Output directory**: \`${outputDir}\``,
    ``,
    `### Files (${writeTasks.length} documents):`,
    ...wikiFiles.map(f => `- \`${f.replace(outputDir + "/", "")}\``),
    ``,
  ].join("\n")

  return { content: [{ type: "text", text: summary }] }
}

// ── LLM caller ──────────────────────────────────────────
async function llmChat(messages: { role: string; content: string }[], opts: { provider: string; baseUrl: string; model: string; apiKey: string }): Promise<string> {
  const url = opts.provider === "ollama"
    ? `${opts.baseUrl.replace(/\/+$/, "")}/api/chat`
    : `${opts.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`

  const body = opts.provider === "ollama"
    ? { model: opts.model, messages, stream: false, options: { num_ctx: 8192 } }
    : { model: opts.model, messages, stream: false, max_tokens: 4096 }

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (opts.apiKey) headers["Authorization"] = `Bearer ${opts.apiKey}`

  const res = await fetch(url, { method: "POST", body: JSON.stringify(body), headers })
  const data = await res.json()

  if (opts.provider === "ollama") return data.message?.content ?? data.response ?? JSON.stringify(data)
  return data.choices?.[0]?.message?.content ?? JSON.stringify(data)
}

import { readdirSync, existsSync } from "fs"
const importMetaDir = import.meta.dir ?? process.cwd()

// ── build_cards ────────────────────────────────────────
interface WikiDoc { dataset: string; docName: string; type: string; chunks: { id: string; content: string }[] }

async function readWikiFiles(wikiDir: string): Promise<WikiDoc[]> {
  if (!existsSync(wikiDir)) throw new Error(`Wiki directory not found: ${wikiDir}`)
  const files = readdirSync(wikiDir).filter(f => f.endsWith(".md"))
  const docs: WikiDoc[] = []
  for (const file of files) {
    const content = await Bun.file(`${wikiDir}/${file}`).text()
    const lines = content.split("\n")
    let dataset = "", docName = "", type = "text"
    const chunks: { id: string; content: string }[] = []
    let currentId = "", currentContent: string[] = []
    let inFrontmatter = false
    for (const line of lines) {
      if (line === "---" && !inFrontmatter) { inFrontmatter = true; continue }
      if (line === "---" && inFrontmatter) { inFrontmatter = false; continue }
      if (inFrontmatter) {
        if (line.startsWith("dataset: ")) dataset = line.slice(9).replace(/^"|"$/g, "")
        if (line.startsWith("document: ")) docName = line.slice(10).replace(/^"|"$/g, "")
        if (line.startsWith("type: ")) type = line.slice(6).trim()
        continue
      }
      const idMatch = line.match(/^\*Чанк: `([^`]+)`\*$/)
      if (idMatch) {
        if (currentContent.length) {
          chunks.push({ id: currentId, content: currentContent.join("\n").trim() })
        }
        currentId = idMatch[1]
        currentContent = []
      } else {
        currentContent.push(line)
      }
    }
    if (currentContent.length) chunks.push({ id: currentId, content: currentContent.join("\n").trim() })
    docs.push({ dataset, docName, type, chunks })
  }
  return docs
}

async function handleBuildCards(args: {
  wiki_dir?: string; output_dir?: string; entity_limit?: number; chunks_per_entity?: number
  provider?: string; base_url?: string; model?: string; api_key?: string
}): Promise<unknown> {
  const wikiDir = args.wiki_dir ?? `${import.meta.dir}/../pipeline-execution/wiki`
  const outputDir = args.output_dir ?? `${import.meta.dir}/../pipeline-execution/cards`
  const entityLimit = args.entity_limit ?? 30
  const llmOpts = {
    provider: args.provider ?? LLM_PROVIDER,
    baseUrl: args.base_url ?? LLM_BASE_URL,
    model: args.model ?? LLM_MODEL,
    apiKey: args.api_key ?? LLM_API_KEY,
  }

  await Bun.$`mkdir -p ${outputDir}`.quiet()
  const docs = await readWikiFiles(wikiDir)
  log(`Read ${docs.length} documents from wiki`)

  // Group by dataset, collect chunk samples per dataset (skip tabular/Excel data)
  const byDataset = new Map<string, { docs: string[]; samples: string[] }>()
  for (const doc of docs) {
    if (doc.type === "tabular") continue
    if (!byDataset.has(doc.dataset)) byDataset.set(doc.dataset, { docs: [], samples: [] })
    const entry = byDataset.get(doc.dataset)!
    entry.docs.push(doc.docName)
    // Sample up to 4 chunks per dataset for entity extraction
    for (const c of doc.chunks.slice(0, 4)) {
      if (c.content.length > 200) entry.samples.push(`[${doc.docName}] ${c.content.slice(0, 600)}`)
    }
  }

  log(`Analyzing ${byDataset.size} datasets for entity extraction`)

  // Phase 1: LLM extracts entities per dataset
  const datasetEntityTasks = [...byDataset.entries()].map(([dsName, { docs, samples }]) => {
    const sampleText = samples.slice(0, 12).join("\n\n---\n\n")
    const prompt = [
      `Ты — аналитик. Ниже — фрагменты текста из датасета "${dsName}".`,
      `В датасете ${docs.length} документов: ${docs.slice(0, 15).join(", ")}${docs.length > 15 ? "..." : ""}.`,
      ``,
      `Выдели ТОП-10 ключевых сущностей из этих текстов.`,
      `Обязательно включи сущности всех типов:`,
      `- **Организации**: институты, агентства, компании, ведомства, военные структуры (например: АСИ, DARPA, НАТО, Ростех, Кремниевая долина)`,
      `- **Технологии**: конкретные технологические направления (например: нейросети, квантовые вычисления, GraphRAG, роевые алгоритмы)`,
      `- **Продукты/системы**: конкретные системы, платформы, вооружения (например: F-35, Starlink, БАС, ФГОС)`,
      `- **Концепции**: стратегии, доктрины, модели (например: когнитивная война, техсуверенитет, форсайт)`,
      ``,
      `Игнорируй общие слова, не связанные с тематикой. Не выделяй фрагменты текста как сущности — используй осмысленные названия.`,
      ``,
      `Ответь строго списком, каждая сущность с новой строки, без нумерации.`,
      `На русском языке.`,
      ``,
      `Сущности:`,
      ``,
      `=== ФРАГМЕНТЫ ===`,
      sampleText,
    ].join("\n")
    return { dataset: dsName, prompt }
  })

  const datasetEntities = await concurrentMap(datasetEntityTasks, async ({ prompt }) => {
    try {
      const result = await llmChat([{ role: "user", content: prompt }], llmOpts)
      const entities = result.split("\n").map(l => l.replace(/^[-–*\d.\s]+/, "").replace(/^["']|["']$/g, "").trim()).filter(l => l.length > 3)
      return entities.slice(0, 15)
    } catch (e: any) {
      log(`LLM error: ${e.message}`)
      return []
    }
  }, 1)

  // Flatten and deduplicate entities across datasets (normalize for dedup)
  const normalize = (s: string) => s.toLowerCase().replace(/\([^)]*\)/g, "").replace(/[–\-_].*$/, "").replace(/[/\\:_]/g, " ").replace(/\s+/g, " ").trim()
  const cleanName = (s: string) => {
    // Remove long trailing descriptions (anything after first 60 chars or after —, ;)
    let name = s.trim()
    // Capitalize first letter
    name = name.replace(/^[а-яa-z]/, c => c.toUpperCase())
    // Truncate at reasonable length
    if (name.length > 80) name = name.slice(0, 77) + "..."
    return name
  }
  const seenNorm = new Set<string>()
  const allEntities: string[] = []
  for (const list of datasetEntities) {
    for (const e of list) {
      const norm = normalize(e)
      if (norm.length > 3 && !seenNorm.has(norm)) {
        seenNorm.add(norm)
        allEntities.push(cleanName(e))
      }
    }
  }
  const sortedEntities = allEntities.slice(0, entityLimit)
  log(`Extracted ${sortedEntities.length} unique entities across all datasets`)

  // Phase 2: for each entity, find relevant chunks across all documents (skip tabular)
  const entityChunks = new Map<string, { dataset: string; doc: string; content: string }[]>()
  for (const entity of sortedEntities) {
    const chunks: { dataset: string; doc: string; content: string }[] = []
    const keyWords = entity.toLowerCase().split(/\s+/).filter(w => w.length > 3)
    if (keyWords.length === 0) continue
    for (const doc of docs) {
      if (doc.type === "tabular") continue
      for (const c of doc.chunks) {
        const lower = c.content.toLowerCase()
        // Match if at least one keyword is found (any, not all)
        const matches = keyWords.some(w => lower.includes(w))
        if (matches) chunks.push({ dataset: doc.dataset, doc: doc.docName, content: c.content.slice(0, 3000) })
        if (chunks.length >= 15) break
      }
    }
    if (chunks.length >= 1) entityChunks.set(entity, chunks) // keep even single-match entities
  }

  log(`Building cards for ${entityChunks.size} entities`)

  // Phase 3: generate cards via LLM
  const cardTasks = [...entityChunks.entries()].map(([entity, chunks]) => {
    const selected = chunks.slice(0, 8)
    const chunkText = selected.map(c => `[${c.dataset}/${c.doc}]\n${c.content.slice(0, 800)}`).join("\n\n---\n\n")
    const sources = [...new Set(selected.map(c => `${c.doc} (${c.dataset})`))]

    const prompt = [
      `Из фрагментов ниже собери структурированную карточку сущности "${entity}".`,
      `Удали повторы, объедини факты в связное описание.`,
      ``,
      `Формат:`,
      `ОПРЕДЕЛЕНИЕ: (1-2 предложения о том, что это)`,
      `ФАКТЫ:`,
      `- конкретный факт из текста (кратко, 1 предложение)`,
      `СВЯЗАНО: (другие организации, технологии, продукты или концепции — используй [[EntityName]])`,
      `- [[EntityName]]`,
      ``,
      `=== ФРАГМЕНТЫ ===`,
      chunkText,
    ].join("\n")
    return { entity, prompt, sources }
  })

  const cardResults = await concurrentMap(cardTasks, async ({ entity, prompt, sources }) => {
    const cardContent = await llmChat([{ role: "user", content: prompt }], llmOpts)
    const safeName = entity.replace(/[/\\:]/g, "_").slice(0, 80)
    const filePath = `${outputDir}/${safeName}.md`
    await Bun.write(filePath, `# Card: ${entity}\n\n${cardContent}\n\n---\n**Источники**:\n${sources.map(s => `- ${s}`).join("\n")}`)
    return filePath
  }, 1)

  // Phase 4: generate cards from tabular (Excel) data — one row = one card
  const tabularDocs = docs.filter(d => d.type === "tabular")
  const tableCards: string[] = []
  for (const doc of tabularDocs) {
    for (const chunk of doc.chunks) {
      const content = chunk.content.trim()
      if (!content || content.length < 20) continue

      const titleMatch = content.match(/ФИО[^：:]*[：:]\s*([^；;]+)/)
      const nameMatch = content.match(/[Нн]аименование[：:]\s*([^；;]+)/)
      const idMatch = content.match(/ID[：:]\s*([^；;]+)/)
      const title = (nameMatch?.[1] || titleMatch?.[1] || idMatch?.[1] || `Record`).trim().slice(0, 60)

      const prompt = [
        `Ниже — строка из таблицы (Excel). Преобразуй её в структурированную карточку.`,
        `Название карточки: "${title}".`,
        `Извлеки ключевые поля: организация, должность, контакты, экспертиза.`,
        `Игнорируй служебные поля (ID, Leader-ID, vkontakte и т.п.).`,
        `Опиши кратко, чем这人 занимается.`,
        ``,
        `Формат:`,
        `ОРГАНИЗАЦИЯ: ...`,
        `ДОЛЖНОСТЬ: ...`,
        `ЭКСПЕРТИЗА: ...`,
        `КОНТАКТЫ: ...`,
        ``,
        `=== СТРОКА ===`,
        content.slice(0, 1500),
      ].join("\n")

      try {
        const cardContent = await llmChat([{ role: "user", content: prompt }], llmOpts)
        const safeName = title.replace(/[/\\:]/g, "_").slice(0, 60)
        const filePath = `${outputDir}/excel_${safeName}.md`
        await Bun.write(filePath, `# Card: ${title}\n\n${cardContent}\n\n---\n**Источник**: ${doc.docName} (${doc.dataset})`)
        tableCards.push(filePath)
      } catch {
        // skip on failure
      }
    }
  }

  const allCards = [...cardResults, ...tableCards]
  const summary = [
    `# Build Cards Summary`,
    ``,
    `- **Datasets analyzed**: ${byDataset.size}`,
    `- **Documents in wiki**: ${docs.length} (${tabularDocs.length} tabular)`,

    `- **Chunks collected**: ${docs.reduce((s, d) => s + d.chunks.length, 0)}`,
    `- **Entity cards built**: ${cardResults.length}`,
    `- **Tabular (Excel) cards built**: ${tableCards.length}`,
    `- **Total cards**: ${allCards.length}`,
    `- **Output directory**: \`${outputDir}\``,
    `- **LLM**: ${llmOpts.provider} / ${llmOpts.model}`,
    ``,
    `### Entity cards:`,
    ...cardResults.map((f, i) => `- ${i + 1}. \`${f?.replace(outputDir + "/", "")}\``),
    ``,
    `### Tabular cards:`,
    ...tableCards.slice(0, 30).map(f => `- \`${f.replace(outputDir + "/", "")}\``),
    ...(tableCards.length > 30 ? [`- ... и ещё ${tableCards.length - 30}`] : []),
    ``,
    `### Entities by dataset:`,
    ...datasetEntities.map((ents, i) => `- ${datasetEntityTasks[i]?.dataset ?? ""}: ${ents.length} entities`),
    ``,
  ].join("\n")

  return { content: [{ type: "text", text: summary }] }
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
          serverInfo: { name: "ragflow-proxy", version: "1.0.0" },
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
