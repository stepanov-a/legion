#!/usr/bin/env bun
// Load test runner for Zulip-Legion integration
// Usage: bun run .legion/test/load/runner.ts <scenario>

import * as fs from "fs"
import * as path from "path"

interface MessageResult {
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

interface TestConfig {
  users: Record<string, string>
  bots: string[]
  questions: string[]
  botToken: Record<string, string>  // bot_email -> service token for direct webhook test
}

const RESULTS_DIR = ".legion/test/results"

function zulipUrl(path: string): string {
  return `https://localhost:8443${path}`
}

const ZULIP_HOST_HEADER = "legion.zulip.local:8443"
const LEGION_URL = "http://localhost:3000"

async function zulipFetch(method: string, path: string, authEmail: string, authKey: string, body?: Record<string, string> | URLSearchParams) {
  const headers: Record<string, string> = {
    "Host": ZULIP_HOST_HEADER,
  }
  if (authEmail && authKey) {
    headers["Authorization"] = "Basic " + Buffer.from(`${authEmail}:${authKey}`).toString("base64")
  }
  const opts: RequestInit = { method, headers }
  if (body) {
    if (method === "GET") {
      const params = body instanceof URLSearchParams ? body : new URLSearchParams(body)
      path += "?" + params.toString()
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded"
      opts.body = body instanceof URLSearchParams ? body.toString() : new URLSearchParams(body).toString()
    }
  }
  const res = await fetch(zulipUrl(path), opts)
  return res.json()
}

async function sendDirectWebhook(senderEmail: string, content: string): Promise<any> {
  const res = await fetch(`${LEGION_URL}/webhook/zulip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bot_email: "consultantbot-bot@zulip.local",
      token: "",
      message: {
        sender_email: senderEmail,
        sender_full_name: senderEmail.split("@")[0],
        content,
        type: "private",
        display_recipient: "dm",
      },
    }),
  })
  return res.json()
}

// Wait for bot response in Zulip
async function waitForBotReply(authEmail: string, authKey: string, anchorId: number, botEmail: string, timeoutMs = 30000): Promise<{ ackMs: number; llmMs: number; ackText: string; llmText: string }> {
  const start = Date.now()
  let ackMs = 0
  let llmMs = 0
  let ackText = ""
  let llmText = ""

  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 2000))
    const url = `/api/v1/messages?anchor=${anchorId}&num_before=0&num_after=10&narrow=${encodeURIComponent(JSON.stringify([{ operator: "dm", operand: botEmail }]))}`
    const data = await zulipFetch("GET", url, authEmail, authKey)
    const msgs = (data as any)?.messages ?? []
    for (const m of msgs) {
      if (m.sender_email === botEmail) {
        const elapsed = Date.now() - start
        if (!ackMs) {
          ackMs = elapsed
          ackText = (m.content as string).replace(/<[^>]+>/g, "").slice(0, 50)
        } else {
          llmMs = elapsed
          llmText = (m.content as string).replace(/<[^>]+>/g, "").slice(0, 100)
        }
      }
    }
    if (llmMs > 0 && ackMs > 0 && llmMs !== ackMs) break
    // If only one message and it's been >5s, might be direct response (no ack needed)
    if (ackMs > 5000 && msgs.filter((m: any) => m.sender_email === botEmail).length === 1) {
      llmMs = ackMs
      llmText = ackText
      break
    }
  }

  return { ackMs, llmMs, ackText, llmText }
}

// ── Scenario A: Simple questions ──────────────────────────────────
async function scenarioA(config: TestConfig) {
  console.log("\n=== Scenario A: Simple questions ===")
  const results: MessageResult[] = []
  let seq = 0

  for (const [userName, userKey] of Object.entries(config.users)) {
    const userEmail = `${userName}@test.legion`
    for (const bot of config.bots) {
      for (const q of config.questions) {
        const sentMs = Date.now()
        const resp: any = await zulipFetch("POST", "/api/v1/messages", userEmail, userKey, {
          type: "private",
          to: bot,
          content: q,
        })

        if (resp.result !== "success") {
          console.log(`  [${seq}] FAIL send: ${userName} -> ${bot}: ${resp.msg}`)
          seq++
          continue
        }

        const msgId = resp.id
        const { ackMs, llmMs, ackText, llmText } = await waitForBotReply(userEmail, userKey, msgId, bot)
        results.push({ seq, user: userName, bot, msgId, sentMs, ackMs, llmMs, ackText, llmText })
        console.log(`  [${seq}] ${userName}->${bot}: ack=${ackMs}ms llm=${llmMs}ms ack="${ackText}" llm="${llmText}"`)
        seq++
      }
    }
  }

  // Save results
  const outPath = path.join(RESULTS_DIR, "a-results.json")
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2))
  console.log(`\nResults saved to ${outPath}`)

  // Analyze
  const ackTimes = results.filter(r => r.ackMs > 0).map(r => r.ackMs)
  const llmTimes = results.filter(r => r.llmMs > 0 && r.llmMs !== r.ackMs).map(r => r.llmMs)

  if (ackTimes.length > 0) {
    ackTimes.sort((a, b) => a - b)
    console.log(`\n--- Ack times (${ackTimes.length} samples) ---`)
    console.log(`  min: ${ackTimes[0]}ms`)
    console.log(`  avg: ${(ackTimes.reduce((a, b) => a + b, 0) / ackTimes.length).toFixed(0)}ms`)
    console.log(`  max: ${ackTimes[ackTimes.length - 1]}ms`)
    console.log(`  p50: ${ackTimes[Math.floor(ackTimes.length * 0.5)]}ms`)
    console.log(`  p95: ${ackTimes[Math.floor(ackTimes.length * 0.95)]}ms`)
  }

  if (llmTimes.length > 0) {
    llmTimes.sort((a, b) => a - b)
    console.log(`\n--- LLM response times (${llmTimes.length} samples) ---`)
    console.log(`  min: ${llmTimes[0]}ms`)
    console.log(`  avg: ${(llmTimes.reduce((a, b) => a + b, 0) / llmTimes.length).toFixed(0)}ms`)
    console.log(`  max: ${llmTimes[llmTimes.length - 1]}ms`)
    console.log(`  p50: ${llmTimes[Math.floor(llmTimes.length * 0.5)]}ms`)
    console.log(`  p95: ${llmTimes[Math.floor(llmTimes.length * 0.95)]}ms`)
  }
}

// ── Scenario C: Burst (10 concurrent DMs to same bot) ────────────
async function scenarioC(config: TestConfig) {
  console.log("\n=== Scenario C: Concurrent DMs (burst) ===")
  const start = Date.now()
  const promises: Promise<void>[] = []
  const results: MessageResult[] = []

  const users = Object.entries(config.users)
  for (let i = 0; i < 10; i++) {
    const [userName, userKey] = users[i % users.length]
    const userEmail = `${userName}@test.legion`
    const bot = config.bots[0]
    const q = `burst test ${i}`
    const sentMs = Date.now()

    promises.push((async () => {
      const resp: any = await zulipFetch("POST", "/api/v1/messages", userEmail, userKey, {
        type: "private", to: bot, content: q,
      })
      if (resp.result === "success") {
        const { ackMs, llmMs, ackText, llmText } = await waitForBotReply(userEmail, userKey, resp.id, bot, 60000)
        results.push({ seq: i, user: userName, bot, msgId: resp.id, sentMs, ackMs, llmMs, ackText, llmText })
        console.log(`  [${i}] ${userName}->${bot}: ack=${ackMs}ms llm=${llmMs}ms`)
      }
    })())
  }

  await Promise.all(promises)
  const totalTime = Date.now() - start

  const outPath = path.join(RESULTS_DIR, "c-results.json")
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2))
  console.log(`\nTotal time: ${totalTime}ms for ${results.length} messages`)
  console.log(`Throughput: ${(results.length / (totalTime / 1000)).toFixed(1)} msg/s`)
}

// ── Scenario B: create_bot under load ───────────────────────────
async function scenarioB(config: TestConfig) {
  console.log("\n=== Scenario B: Create bots under load ===")
  const start = Date.now()
  const results: any[] = []

  for (let i = 0; i < 5; i++) {
    const name = `load-bot-${i}`
    const t0 = Date.now()
    try {
      const resp = await sendDirectWebhook(
        "user1@test.legion",
        `создай бота ${name}, канал general, описание нагрузочный тест ${i}, промпт: ты нагрузочный бот ${i}`
      )
      const t1 = Date.now()
      results.push({ bot: name, timeMs: t1 - t0, response: resp })
      console.log(`  [${i}] create_bot ${name}: ${t1 - t0}ms`)
    } catch (e: any) {
      console.log(`  [${i}] ${name}: ERROR ${e.message}`)
    }
  }

  // Wait for LLM to finish creating bots (async via ack)
  await new Promise(r => setTimeout(r, 30000))

  // Check which bots were actually created
  for (let i = 0; i < 5; i++) {
    const name = `load-bot-${i}`
    const mdExists = fs.existsSync(`.legion/command/${name}.md`)
    const s3Check = false // would need S3 API call
    console.log(`  bot ${name}: local_md=${mdExists}`)
  }

  const outPath = path.join(RESULTS_DIR, "b-results.json")
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2))
  console.log(`\nDone in ${Date.now() - start}ms`)
}

// ── Scenario E: Long session (100 messages) ──────────────────────
async function scenarioE(config: TestConfig) {
  console.log("\n=== Scenario E: Long session ===")
  const [userName, userKey] = Object.entries(config.users)[0]
  const userEmail = `${userName}@test.legion`
  const bot = config.bots[0]
  const results: any[] = []

  for (let i = 0; i < 20; i++) {  // 20 instead of 100 to keep test time reasonable
    const t0 = Date.now()
    const resp: any = await zulipFetch("POST", "/api/v1/messages", userEmail, userKey, {
      type: "private", to: bot, content: `сообщение номер ${i}`,
    })
    if (resp.result !== "success") {
      console.log(`  [${i}] FAIL: ${resp.msg}`)
      continue
    }
    const { ackMs, llmMs } = await waitForBotReply(userEmail, userKey, resp.id, bot, 45000)
    results.push({ seq: i, ackMs, llmMs })
    console.log(`  [${i}] ack=${ackMs}ms llm=${llmMs}ms`)

    // Check LLM response consistency
    if (llmMs > 15000 && i > 0) {
      console.log(`  WARN: message ${i} took ${llmMs}ms — possible context growth`)
    }
  }

  const outPath = path.join(RESULTS_DIR, "e-results.json")
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2))
  console.log(`\nTotal: ${results.length} messages`)
  if (results.length > 0) {
    const ackTimes = results.filter(r => r.ackMs > 0).map(r => r.ackMs)
    const llmTimes = results.filter(r => r.llmMs > 0).map(r => r.llmMs)
    console.log(`Ack: min=${Math.min(...ackTimes)}ms avg=${(ackTimes.reduce((a, b) => a + b, 0) / ackTimes.length).toFixed(0)}ms max=${Math.max(...ackTimes)}ms`)
    console.log(`LLM: min=${Math.min(...llmTimes)}ms avg=${(llmTimes.reduce((a, b) => a + b, 0) / llmTimes.length).toFixed(0)}ms max=${Math.max(...llmTimes)}ms`)
  }
}

// ── Main ─────────────────────────────────────────────────────────
const config: TestConfig = {
  users: {
    user1: "xnWOhucuGdaIp12K9wYClAc0fiNuXU3u",
    user2: "STiQLeQktcdkxLD0wUsTVtttwsqSnIMZ",
    user3: "76U4Og4Ckaq5e2UerOAvmNNDEVv98GgQ",
  },
  bots: ["consultantbot-bot@zulip.local", "adminbotv2-bot@zulip.local"],
  questions: ["привет", "как дела", "что нового", "расскажи о себе", "помоги"],
  botToken: {},
}

fs.mkdirSync(RESULTS_DIR, { recursive: true })

const scenario = process.argv[2] ?? "a"
switch (scenario) {
  case "a": await scenarioA(config); break
  case "c": await scenarioC(config); break
  case "b": await scenarioB(config); break
  case "e": await scenarioE(config); break
  default: console.log("Usage: bun run .legion/test/load/runner.ts <a|b|c|e>"); break
}
