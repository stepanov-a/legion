#!/usr/bin/env bun
// Analyze load test results and generate summary
import * as fs from "fs"
import * as path from "path"

const RESULTS_DIR = ".legion/test/results"

interface Result {
  seq: number
  user: string
  bot: string
  msgId: number
  sentMs: number
  ackMs: number
  llmMs: number
  ackText: string
  llmText: string
}

function loadScenario(name: string): Result[] {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${name}-results.json`), "utf-8"))
    return Array.isArray(data) ? data : []
  } catch { return [] }
}

function stats(times: number[], label: string) {
  if (times.length === 0) return
  const sorted = [...times].sort((a, b) => a - b)
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length
  console.log(`  ${label}: n=${times.length}`)
  console.log(`    min: ${sorted[0]}ms`)
  console.log(`    avg: ${avg.toFixed(0)}ms`)
  console.log(`    max: ${sorted[sorted.length - 1]}ms`)
  console.log(`    p50: ${sorted[Math.floor(sorted.length * 0.5)]}ms`)
  console.log(`    p95: ${sorted[Math.floor(sorted.length * 0.95)]}ms`)
  console.log(`    p99: ${sorted[Math.floor(sorted.length * 0.99)]}ms`)
}

function findAnomalies(results: Result[]): string[] {
  const anomalies: string[] = []
  for (const r of results) {
    if (r.ackMs === 0) anomalies.push(`[${r.seq}] ${r.user}->${r.bot}: no ack`)
    if (r.llmMs === 0) anomalies.push(`[${r.seq}] ${r.user}->${r.bot}: no llm response`)
    if (r.llmMs > 10000) anomalies.push(`[${r.seq}] ${r.user}->${r.bot}: slow llm (${r.llmMs}ms)`)
    if (r.ackText.includes("denied")) anomalies.push(`[${r.seq}] ${r.user}->${r.bot}: access denied`)
  }
  return anomalies
}

console.log("=".repeat(60))
console.log("LOAD TEST RESULTS SUMMARY")
console.log("=".repeat(60))

// Scenario A
const a = loadScenario("a")
console.log("\n--- Scenario A: Simple questions (3 users × 2 bots × 5 questions) ---")
stats(a.filter(r => r.ackMs > 0).map(r => r.ackMs), "Ack time")
stats(a.filter(r => r.llmMs > 0 && r.llmMs !== r.ackMs).map(r => r.llmMs), "LLM time")

// Split by bot
for (const bot of [...new Set(a.map(r => r.bot))]) {
  const botResults = a.filter(r => r.bot === bot)
  console.log(`\n  Bot: ${bot} (${botResults.length} messages)`)
  stats(botResults.filter(r => r.llmMs > 0).map(r => r.llmMs), "  LLM time")
  // Show access denied count
  const denied = botResults.filter(r => r.ackText.includes("denied")).length
  if (denied > 0) console.log(`  Access denied: ${denied}/${botResults.length}`)
}

// Anomalies
const anomaliesA = findAnomalies(a)
if (anomaliesA.length > 0) {
  console.log("\n  Anomalies:")
  for (const a of anomaliesA) console.log(`    ${a}`)
}

// Scenario B
const b = loadScenario("b")
console.log("\n--- Scenario B: Create bots under load (5 bots) ---")
if (b.length > 0) {
  stats(b.map(r => r.timeMs), "create_bot time")
}

// Scenario C
const c = loadScenario("c")
console.log("\n--- Scenario C: Concurrent DMs (burst, 10 messages) ---")
stats(c.filter(r => r.ackMs > 0).map(r => r.ackMs), "Ack time")
stats(c.filter(r => r.llmMs > 0 && r.llmMs !== r.ackMs).map(r => r.llmMs), "LLM time")
const anomaliesC = findAnomalies(c)
if (anomaliesC.length > 0) {
  console.log("\n  Anomalies:")
  for (const a of anomaliesC) console.log(`    ${a}`)
}

// Scenario E
const e = loadScenario("e")
console.log("\n--- Scenario E: Long session (20 messages) ---")
stats(e.filter(r => r.ackMs > 0).map(r => r.ackMs), "Ack time")
stats(e.filter(r => r.llmMs > 0 && r.llmMs !== r.ackMs).map(r => r.llmMs), "LLM time")

// Check for context growth
const eLlm = e.filter(r => r.llmMs > 0).map(r => r.llmMs)
if (eLlm.length > 5) {
  const first5 = eLlm.slice(0, 5).reduce((a, b) => a + b, 0) / 5
  const last5 = eLlm.slice(-5).reduce((a, b) => a + b, 0) / 5
  console.log(`  Context growth: first5=${first5.toFixed(0)}ms last5=${last5.toFixed(0)}ms (${((last5/first5 - 1) * 100).toFixed(1)}%)`)
}

// Overall
console.log("\n" + "=".repeat(60))
console.log("OVERALL")

const allAck = [...a, ...c, ...e].filter(r => r.ackMs > 0).map(r => r.ackMs)
const allLlm = [...a, ...c, ...e].filter(r => r.llmMs > 0 && r.llmMs !== r.ackMs).map(r => r.llmMs)
stats(allAck, "Ack time (all)")
stats(allLlm, "LLM time (all)")

const totalMsgs = a.length + b.length + c.length + e.length
const failed = anomaliesA.length
console.log(`\nTotal messages: ${totalMsgs}`)
console.log(`Failed/lost: ${failed}`)
console.log(`Reliability: ${((totalMsgs - failed) / totalMsgs * 100).toFixed(1)}%`)
