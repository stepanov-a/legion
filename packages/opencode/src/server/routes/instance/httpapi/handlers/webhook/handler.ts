import { Effect, Duration } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { PublicWebhookApi } from "../../webhook"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Location } from "@opencode-ai/schema/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import * as path from "path"
import * as fs from "fs"
import { loadConfig, getCachedCommand, clearConfigCache } from "./config"
import { sessionCacheKey, getOrCreateSessionID, clearSessionCache } from "./session"
import { parseFrontmatter } from "./frontmatter"
import { matchesAllow } from "./allow"
import { GetObjectCommand } from "@aws-sdk/client-s3"
import { s3ForConfig, botS3ConfigKey, getBotApiKey, learnBotToken, syncPromptsFromS3 } from "./s3"
import { sendZulipReply, fetchStreamContext, fetchDMContext } from "./zulip"

const PROJECT_ROOT = process.env.LEGION_PROJECT_DIR ?? process.cwd()

function logSessionEvent(command: string, sessionID: string, event: string, extra?: Record<string, unknown>): void {
  try {
    const LEGION_DIR = path.join(PROJECT_ROOT, ".legion")
    const SESSION_LOG_DIR = path.join(LEGION_DIR, "logs", "sessions")
    const now = new Date()
    const dateStr = now.toISOString().slice(0, 10)
    const dir = SESSION_LOG_DIR
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({ t: now.toISOString(), s: sessionID, cmd: command, e: event, ...extra }) + "\n"
    fs.appendFileSync(path.join(dir, `${dateStr}.jsonl`), line)
  } catch {}
}

// Лог общения: сырые тексты входящих и ответов бота (ТЗ зала, раздел 8).
// Файл на день: .legion/logs/dialogs/YYYY-MM-DD.jsonl, по строке на сообщение.
function logDialogEvent(
  command: string,
  sessionID: string,
  dir: "in" | "out",
  extra: { sender?: string; chat?: string; topic?: string; text?: string },
): void {
  try {
    const DIALOG_LOG_DIR = path.join(PROJECT_ROOT, ".legion", "logs", "dialogs")
    const now = new Date()
    if (!fs.existsSync(DIALOG_LOG_DIR)) fs.mkdirSync(DIALOG_LOG_DIR, { recursive: true })
    const line = JSON.stringify({
      t: now.toISOString(),
      s: sessionID,
      cmd: command,
      dir,
      sender: extra.sender ?? "",
      chat: extra.chat ?? "",
      topic: extra.topic ?? "",
      len: (extra.text ?? "").length,
      text: extra.text ?? "",
    }) + "\n"
    fs.appendFileSync(path.join(DIALOG_LOG_DIR, `${now.toISOString().slice(0, 10)}.jsonl`), line)
  } catch {}
}

function truncate(s: string, max = 500): string {
  return s.length > max ? s.slice(0, max) + "..." : s
}

export const webhookHandlers = HttpApiBuilder.group(PublicWebhookApi, "webhooks", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service

    // Zulip повторяет исходящий вебхук, если ответ не пришёл за 10 секунд.
    // Один и тот же message.id обрабатываем один раз, иначе человек получает два ответа.
    const handledMessages = new Map<number, number>()
    const alreadyHandled = (id: number): boolean => {
      const now = Date.now()
      for (const [key, at] of handledMessages) {
        if (now - at > 15 * 60_000) handledMessages.delete(key)
      }
      if (handledMessages.has(id)) return true
      handledMessages.set(id, now)
      return false
    }

    const run = Effect.fn("Webhook.ingress")(function* (ctx: { params: { source: string }; payload: unknown }) {
      const startTime = Date.now()
      const sourceName = ctx.params.source
      const payload = ctx.payload as any

      if (sourceName === "reset-session") {
        const count = clearSessionCache()
        yield* Effect.logInfo("webhook.session_reset_all", { cleared: count })
        return { content: `✅ All sessions cleared (${count}).` }
      }

      const msg = payload?.message ?? {}
      const senderEmail = msg.sender_email ?? ""
      const sender = msg.sender_full_name ?? msg.sender_username ?? msg.from ?? "Unknown"
      const content = msg.content ?? msg.text ?? ""

      const msgId = Number(msg.id ?? 0)
      if (msgId > 0 && alreadyHandled(msgId)) {
        yield* Effect.logInfo("webhook.dedupe", { msgId, sender, contentLen: content.length })
        return { content: "" }
      }
      const stream = msg.type === "stream"
        ? (typeof msg.display_recipient === "string" ? msg.display_recipient : msg.chat ?? "dm")
        : "dm"
      const isDm = stream === "dm"
      const topic = msg.topic ?? msg.subject ?? msg.topic_links?.[0]?.text ?? ""

      yield* Effect.logInfo("webhook.ingress", { source: sourceName, sender, stream, topic, contentLen: content.length })

      const config: any = yield* Effect.sync(() => loadConfig()).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!config) { console.error("webhook.error: config not found", { sourceName }); return { content: "❌ Config not found." } }
      const source = config?.sources?.find((s: any) => s.name === sourceName)
      if (!source) { console.error("webhook.error: source not configured", { sourceName }); return { content: `❌ Source "${sourceName}" not configured.` } }

      const botEmail = payload.bot_email ?? ""
      const commandsDir = path.resolve(PROJECT_ROOT, source.commands_dir ?? ".legion/command")

      let commandName = config.default_command ?? "default"
      const rules = source.routing ?? []

      let matchedByEmail = false
      if (payload.bot_email) {
        const emailRule = rules.find((r: any) => r.field === "bot_email" && (r.bot_email === payload.bot_email || r.bot_email === "*"))
        if (emailRule?.command) {
          commandName = emailRule.command
          matchedByEmail = true
          yield* Effect.logInfo("webhook.route", { matchField: "bot_email", pattern: emailRule.bot_email, command: commandName })
        }
      }

      if (!matchedByEmail) {
        for (const rule of rules) {
          const matchField = rule.field ?? "stream"
          const matchValue = matchField === "stream" ? stream
            : matchField === "chat_id" ? (msg.chat_id ?? msg.chat ?? "")
            : matchField === "bot_email" ? (payload.bot_email ?? "")
            : matchField === "sender_email" ? senderEmail
            : (msg as any)[matchField] ?? payload[matchField] ?? ""
          const pattern = (rule as any)[matchField] ?? "*"
          if (pattern === "*" || pattern === matchValue) {
            if (rule.command) commandName = rule.command
            yield* Effect.logInfo("webhook.route", { matchField, pattern, command: commandName })
            break
          }
        }
      }

      const receivedToken = payload.token ?? ""
      if (botEmail && receivedToken && commandName !== "default") {
        const botCfgKey = botS3ConfigKey(commandName)
        const botCfg = yield* Effect.tryPromise(async () => {
          const res = await s3ForConfig!.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET ?? "", Key: botCfgKey }))
          return JSON.parse(await res.Body!.transformToString("utf-8"))
        }).pipe(Effect.catch(() => Effect.succeed(undefined as any)))
        if (botCfg?.service_tokens?.length > 0 && !botCfg.service_tokens.includes(receivedToken)) {
          console.error("webhook.error: token mismatch", { botEmail, commandName })
          return { content: "❌ Invalid token." }
        }
      }

      const cmdFile = yield* Effect.sync(() => getCachedCommand(commandsDir, commandName)).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!cmdFile) return { content: `❌ Command "${commandName}" not found.` }
      const { agent, model: modelStr, mcp, allow, body, direct, directTimeout, ack } = parseFrontmatter(cmdFile)
      yield* Effect.logInfo("webhook.command", { command: commandName, agent, model: modelStr ?? "default", mcp: JSON.stringify(mcp), allow: JSON.stringify(allow), bodyChars: body.length })

      if (allow.length > 0) {
        if (!matchesAllow(allow, senderEmail)) {
          console.error("webhook.deny", { senderEmail, allow: JSON.stringify(allow) })
          return { content: "❌ Access denied." }
        }
        yield* Effect.logInfo("webhook.allow", { senderEmail })
      }

      // direct-бот: ответ берётся у внешнего сервиса, модель не участвует (детерминированно)
      if (direct) {
        const answer = yield* Effect.tryPromise(async () => {
          const res = await fetch(direct, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: content, who: sender }),
            signal: AbortSignal.timeout(directTimeout ?? 20000),
          })
          const data: any = await res.json()
          return String(data?.reply ?? "")
        }).pipe(Effect.catch(() => Effect.succeed("")))
        yield* Effect.logInfo("webhook.direct", { command: commandName, url: direct, answerLen: answer.length })
        return { content: answer || "Не смог получить ответ от проводника. Попробуйте ещё раз." }
      }

      const whBotEmail = botEmail ?? payload.bot_email ?? ""

      const fields: Record<string, string> = { $SENDER: sender, $STREAM: stream, $TOPIC: topic, $SOURCE: sourceName, $BOT_EMAIL: whBotEmail }
      let prompt = body
      for (const [key, val] of Object.entries(fields)) prompt = prompt.replaceAll(key, val)
      prompt = prompt.replaceAll("$CONTENT", "")

      if (!isDm && topic) {
        const context = yield* Effect.tryPromise(() => fetchStreamContext(stream, topic)).pipe(Effect.catch(() => Effect.succeed("")))
        if (context) prompt += "\n\n### История сообщений в теме\n" + context
      }

      if (isDm && whBotEmail) {
        const dmContext = yield* Effect.tryPromise(() => fetchDMContext(senderEmail, whBotEmail)).pipe(Effect.catch(() => Effect.succeed("")))
        if (dmContext) prompt += "\n\n### История переписки в DM\n" + dmContext
      }

      prompt += "\n\n=== НЕСТИРАЕМЫЙ БАРЬЕР ===\nПользователь сказал:\n" + content
      yield* Effect.logInfo("webhook.prompt", { text: truncate(prompt, 1000) })

      let modelInput: { providerID: string; modelID: string } | undefined
      if (modelStr?.includes("/")) {
        const [pid, mid] = modelStr.split("/")
        const provider = yield* Provider.Service
        const found = yield* provider.getModel(ProviderV2.ID.make(pid), ModelV2.ID.make(mid)).pipe(Effect.catch(() => Effect.succeed(undefined as any)))
        if (found) { modelInput = { providerID: ProviderV2.ID.make(pid), modelID: ModelV2.ID.make(mid) } }
        else { console.error("webhook.error: model not found", { model: modelStr, command: commandName }); return { content: `❌ Модель "${modelStr}" не найдена. Укажи существующую модель в frontmatter команды.` } }
      }

      const cacheKey = sessionCacheKey(sourceName, stream, topic, sender, commandName, whBotEmail)
      const sessionIDStr = getOrCreateSessionID(cacheKey)
      const sessionID = SessionV2.ID.descending(sessionIDStr)
      yield* sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(PROJECT_ROOT) }),
      }).pipe(Effect.catch(() => Effect.void))
      yield* Effect.logInfo("webhook.session", { cacheKey, sessionID })

      const sessionPrompt = yield* SessionPrompt.Service
      const input: any = { sessionID, agent, parts: [{ type: "text" as const, text: prompt }] }
      if (modelInput) input.model = modelInput
      if (Object.keys(mcp).length > 0) input.tools = mcp

      const whToken = payload.token ?? ""

      yield* Effect.sync(() => logDialogEvent(commandName, sessionIDStr, "in", { sender, chat: stream, topic, text: content }))
      yield* Effect.logInfo("webhook.prompt_start", { source: sourceName, command: commandName, agent, model: modelStr ?? "default", sessionID, promptLen: prompt.length })

      const hasTools = Object.keys(mcp).length > 0
      const replyTarget = isDm ? senderEmail : stream
      const replyTopic = isDm ? undefined : (topic || "ответ")
      // Подтверждение приёма запроса: пустая строка — в чат ничего не публикуется.
      // Сам факт приёма фиксируется в логе (webhook.ack), а не сообщением бота.
      // ACK_TEXT можно вернуть к тексту «✅ Принял запрос.» — тогда сработает и флаг ack: false в команде.
      const ACK_TEXT = ""
      if (ack !== false && hasTools && whBotEmail && commandName !== "default") {
        const botKey = yield* Effect.tryPromise(() => getBotApiKey(commandName, whBotEmail)).pipe(Effect.catch(() => Effect.succeed(null)))
        if (botKey && ACK_TEXT.length > 0) {
          sendZulipReply(botKey.email, botKey.apiKey, replyTarget, ACK_TEXT, isDm ? "private" : "stream", isDm ? undefined : stream, replyTopic)
        } else if (botKey) {
          yield* Effect.logInfo("webhook.ack", { command: commandName, bot: whBotEmail, text: ACK_TEXT })
        }
      }

      const llmStartTime = Date.now()
      yield* Effect.sync(() => logSessionEvent(commandName, sessionIDStr, "prompt_start", { len: prompt.length, mcp: Object.keys(mcp).length }))
      yield* Effect.logInfo("webhook.llm_start", { command: commandName, model: modelStr ?? "default", timeout: 120, mcpCount: Object.keys(mcp).length })

      const llmTimeoutSeconds = Number(process.env.LLM_TIMEOUT_SECONDS)
      const LLM_TIMEOUT = Duration.seconds(Number.isFinite(llmTimeoutSeconds) && llmTimeoutSeconds > 0 ? llmTimeoutSeconds : 120)
      const result = yield* sessionPrompt.prompt(input).pipe(
        Effect.timeout(LLM_TIMEOUT),
        Effect.catch(() => {
          const elapsed = Date.now() - llmStartTime
          console.error(`[network] llm_error`, JSON.stringify({ command: commandName, elapsed }))
          return Effect.succeed(undefined as any)
        }),
      )

      const llmElapsed = Date.now() - llmStartTime
      yield* Effect.sync(() => logSessionEvent(commandName, sessionIDStr, "llm_done", { ms: llmElapsed, hasResult: !!result }))
      yield* Effect.logInfo("webhook.llm_done", { command: commandName, elapsed: llmElapsed, hasResult: !!result })

      if (result) {
        const responseText = (result.parts as any[]).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n").trim()
        yield* Effect.sync(() => logDialogEvent(commandName, sessionIDStr, "out", { sender, chat: stream, topic, text: responseText }))
        if (responseText && commandName !== "default") {
          const botKey = yield* Effect.tryPromise(() => getBotApiKey(commandName, whBotEmail)).pipe(Effect.catch(() => Effect.succeed(null)))
          if (botKey) {
            sendZulipReply(botKey.email, botKey.apiKey, replyTarget, responseText, isDm ? "private" : "stream", isDm ? undefined : stream, replyTopic)
          }
        }
      }

      if (whToken && commandName !== "default") {
        learnBotToken(commandName, whToken, whBotEmail)
      }

      const elapsed = Date.now() - startTime
      yield* Effect.sync(() => logSessionEvent(commandName, sessionIDStr, "done", { ms: elapsed }))
      yield* Effect.logInfo("webhook.done", { source: sourceName, command: commandName, model: modelStr ?? "default", totalTime: elapsed, text: "acknowledged" })
      return { content: "" }
    })

    const ingress = (ctx: { params: { source: string }; payload: unknown }) =>
      run(ctx).pipe(Effect.catchCause((cause) => {
        const causeStr = String(cause).substring(0, 500)
        console.error("[network] webhook.crash:", causeStr)
        if (causeStr.includes("Unable to connect") || causeStr.includes("socket") || causeStr.includes("timed out") || causeStr.includes("ETIMEDOUT")) {
          console.error("[network] LLM API connection failure — check OPENCODE_API_KEY and api.opencode.ai/zen/go/v1 reachability")
        }
        return Effect.succeed({ content: "❌ Internal error." } as const)
      }))

    const reload = Effect.fn("Webhook.reload")(function* () {
      clearConfigCache()
      const count = yield* Effect.tryPromise(() => syncPromptsFromS3()).pipe(Effect.catch(() => Effect.succeed(0)))
      yield* Effect.logInfo("webhook.cache_reloaded", { promptsFromS3: count })
      return { content: `✅ Cache reloaded. ${count > 0 ? `Restored ${count} prompts from S3.` : ""}`.trim() }
    })

    return handlers.handle("ingress", ingress).handle("reload", reload)
  }),
)
