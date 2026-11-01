export function parseFrontmatter(text: string): { agent: string; model?: string; mcp: Record<string, boolean>; allow: string[]; body: string; direct?: string; directTimeout?: number; ack?: boolean } {
  if (!text.startsWith("---")) return { agent: "general", mcp: {}, allow: [], body: text.trim() }
  const parts = text.split("---")
  if (parts.length < 3) return { agent: "general", mcp: {}, allow: [], body: text.trim() }
  const fm = parts[1]
  const mcpRaw = fm.match(/mcp:\s*\{([^}]+)\}/)?.[1]
  const mcp: Record<string, boolean> = {}
  if (mcpRaw) {
    for (const pair of mcpRaw.split(",")) {
      const [k, v] = pair.split(":").map(s => s.trim())
      if (k) mcp[k] = v === "true" || v === "yes"
    }
  }
  const allowRaw = fm.match(/allow:\s*\[([^\]]+)\]/)?.[1]
  const allow: string[] = allowRaw ? allowRaw.split(",").map(s => s.trim().replace(/['"]/g, "")) : []
  // direct: URL — бот отвечает не моделью, а вызовом сервиса (детерминированный ответ)
  const direct = fm.match(/direct:\s*(\S+)/)?.[1]
  const directTimeout = Number(fm.match(/direct_timeout:\s*(\d+)/)?.[1] ?? 0) || undefined
  // ack: false — не отправлять «✅ Принял запрос.» перед ответом (для команд, где это шум)
  const ackRaw = fm.match(/ack:\s*(true|false)/)?.[1]
  const ack = ackRaw === undefined ? undefined : ackRaw === "true"
  return {
    agent: fm.match(/agent:\s*(\S+)/)?.[1] ?? "general",
    model: fm.match(/model:\s*(\S+)/)?.[1],
    mcp,
    allow,
    body: parts.slice(2).join("---").trim(),
    direct,
    directTimeout,
    ack,
  }
}
