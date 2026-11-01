const MAX_ZULIP_MSG = 9000

const ZULIP_URL = process.env.ZULIP_URL ?? ""
const ZULIP_HOST = process.env.ZULIP_API_HOST ?? ""

function zulipAdminAuth(): string {
  return "Basic " + Buffer.from(`${process.env.ZULIP_EMAIL}:${process.env.ZULIP_API_KEY}`).toString("base64")
}

export async function zulipSendMessage(botEmail: string, botApiKey: string, recipient: string, content: string, msgType?: string, topic?: string): Promise<void> {
  if (!ZULIP_URL || !ZULIP_HOST) { console.error("[network] zulipSendMessage: ZULIP_URL and ZULIP_API_HOST must be set"); return }
  const auth = "Basic " + Buffer.from(`${botEmail}:${botApiKey}`).toString("base64")

  // Re-upload any admin-owned attachments with the bot's key, so the bot owns them
  const fixed = await reuploadAsBot(content, botEmail, botApiKey)

  const body: Record<string, string> = { content: fixed }
  if (msgType === "stream") {
    body.type = "stream"
    body.to = recipient
    if (topic) body.topic = topic
  } else {
    body.type = "private"
    body.to = recipient
  }
  try {
    const res = await fetch(`${ZULIP_URL}/api/v1/messages`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded", Host: ZULIP_HOST },
      body: new URLSearchParams(body).toString(),
    })
    const json = await res.json()
    if (json.result !== "success") {
      console.error("[network] zulipSendMessage error:", json.msg, { botEmail })
    }
  } catch (e: any) {
    const msg = e.message ?? String(e)
    if (msg.includes("Unable to connect") || msg.includes("resolve") || msg.includes("timed out")) {
      console.error(`[network] zulipSendMessage failed: ${msg}`, { botEmail })
    } else {
      console.error(`[network] zulipSendMessage exception: ${msg}`, { botEmail })
    }
  }
}

async function reuploadAsBot(content: string, botEmail: string, botApiKey: string): Promise<string> {
  const urlRe = /(https?:\/\/[^\/\s]+)?\/user_uploads\/(\d+\/[^/]+\/[^)]+)/g
  const botAuth = "Basic " + Buffer.from(`${botEmail}:${botApiKey}`).toString("base64")
  let result = content
  let m: RegExpExecArray | null
  const seen = new Set<string>()

  while ((m = urlRe.exec(result)) !== null) {
    const rawPath = m[2].replace(/[)\]>'".,;:!]+$/, "")
    if (seen.has(rawPath)) continue
    seen.add(rawPath)

    const pathId = decodeURIComponent(rawPath)
    try {
      const dl = await fetch(`${ZULIP_URL}/user_uploads/${pathId}?api_key=${process.env.ZULIP_API_KEY}`, {
        headers: { Host: ZULIP_HOST },
      })
      if (!dl.ok) continue
      const buffer = await dl.arrayBuffer()
      const fileName = pathId.split("/").pop() ?? "file"
      const form = new FormData()
      form.append("file", new Blob([buffer]), fileName)
      const up = await fetch(`${ZULIP_URL}/api/v1/user_uploads`, {
        method: "POST",
        headers: { Authorization: botAuth, Host: ZULIP_HOST },
        body: form,
      })
      const upJson: any = await up.json()
      if (upJson.result === "success") {
        // Replace old URL with new bot-owned URL in the content
        const newUri = decodeURIComponent(upJson.uri)
        const oldFull = m[0]
        result = result.replace(oldFull, newUri)
        console.log("[network] reuploaded for bot:", { pathId, botEmail, newUri })
        urlRe.lastIndex = 0 // reset regex
      }
    } catch {}
  }
  return result
}

function chunkContent(content: string): string[] {
  if (content.length <= MAX_ZULIP_MSG) return [content]
  const chunks: string[] = []
  let start = 0
  while (start < content.length) {
    let end = start + MAX_ZULIP_MSG
    if (end >= content.length) {
      chunks.push(content.slice(start))
      break
    }
    const slice = content.slice(start, end)
    const breakAt = Math.max(
      slice.lastIndexOf("\n\n"),
      slice.lastIndexOf("\n"),
      slice.lastIndexOf(". "),
      slice.lastIndexOf(" "),
    )
    end = breakAt > MAX_ZULIP_MSG / 2 ? start + breakAt + 1 : end
    chunks.push(content.slice(start, end))
    start = end
  }
  return chunks
}

export async function sendZulipReply(botEmail: string, botApiKey: string, toEmail: string, content: string, msgType?: string, streamName?: string, topic?: string): Promise<void> {
  try {
    const parts = chunkContent(content)
    const isStream = msgType === "stream" && streamName && streamName !== "dm"
    for (let i = 0; i < parts.length; i++) {
      const label = parts.length > 1 ? `(${i + 1}/${parts.length})\n\n` : ""
      if (isStream) {
        await zulipSendMessage(botEmail, botApiKey, streamName!, label + parts[i], "stream", topic)
      } else {
        await zulipSendMessage(botEmail, botApiKey, toEmail, label + parts[i])
      }
    }
  } catch (e: any) {
    console.error("sendZulipReply exception:", e.message)
  }
}

export async function fetchStreamContext(streamName: string, topicName: string): Promise<string> {
  if (!streamName || streamName === "dm" || !topicName) return ""
  try {
    const narrow = JSON.stringify([
      { operator: "stream", operand: streamName },
      { operator: "topic", operand: topicName },
    ])
    const zulipUrl = process.env.ZULIP_URL ?? ""
    const zulipHost = process.env.ZULIP_API_HOST ?? ""
    if (!zulipUrl || !zulipHost) return ""
    const auth = "Basic " + Buffer.from(
      `${process.env.ZULIP_EMAIL}:${process.env.ZULIP_API_KEY}`
    ).toString("base64")
    const url = `${zulipUrl}/api/v1/messages?anchor=newest&num_before=10&num_after=0&narrow=${encodeURIComponent(narrow)}`
    const res = await fetch(url, { headers: { Authorization: auth, Host: zulipHost } })
    const data: any = await res.json()
    if (data.result !== "success") return ""
    const msgs = (data.messages ?? []).slice(0, 10).reverse()
    if (msgs.length === 0) return ""
    return msgs.map((m: any) => {
      const sender = m.sender_full_name ?? m.sender_email ?? "?"
      const content = (m.content ?? "").replace(/<[^>]+>/g, "")
      return `${sender}: ${content}`
    }).join("\n")
  } catch { return "" }
}

export async function fetchDMContext(senderEmail: string, botEmail: string): Promise<string> {
  if (!senderEmail || !botEmail) return ""
  try {
    const narrow = JSON.stringify([
      { operator: "dm", operand: botEmail },
    ])
    const zulipUrl = process.env.ZULIP_URL ?? ""
    const zulipHost = process.env.ZULIP_API_HOST ?? ""
    if (!zulipUrl || !zulipHost) return ""
    const auth = "Basic " + Buffer.from(
      `${process.env.ZULIP_EMAIL}:${process.env.ZULIP_API_KEY}`
    ).toString("base64")
    const url = `${zulipUrl}/api/v1/messages?anchor=newest&num_before=10&num_after=0&narrow=${encodeURIComponent(narrow)}`
    const res = await fetch(url, { headers: { Authorization: auth, Host: zulipHost } })
    const data: any = await res.json()
    if (data.result !== "success") return ""
    const msgs = (data.messages ?? []).filter((m: any) => {
      const recipients = Array.isArray(m.display_recipient) ? m.display_recipient.map((r: any) => r.email) : []
      return recipients.includes(senderEmail) && recipients.includes(botEmail)
    }).slice(0, 10).reverse()
    if (msgs.length === 0) return ""
    return msgs.map((m: any) => {
      const sender = m.sender_full_name ?? m.sender_email ?? "?"
      const content = (m.content ?? "").replace(/<[^>]+>/g, "")
      return `${sender}: ${content}`
    }).join("\n")
  } catch { return "" }
}
