import * as path from "path"
import * as fs from "fs"
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"

const PROJECT_ROOT = process.env.LEGION_PROJECT_DIR ?? process.cwd()
const LEGION_DIR = path.join(PROJECT_ROOT, ".legion")
const BOTS_S3_BUCKET = process.env.S3_BUCKET ?? ""

export const s3ForConfig = process.env.S3_ENDPOINT && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY && process.env.S3_BUCKET
  ? new S3Client({
      region: process.env.S3_REGION ?? "us-east-1",
      endpoint: process.env.S3_ENDPOINT,
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY!, secretAccessKey: process.env.S3_SECRET_KEY! },
      forcePathStyle: true,
    })
  : null

export function botS3ConfigKey(commandName: string): string {
  return `bot-prompts/${commandName}/config.json`
}

export async function getBotApiKey(commandName: string, botEmail?: string): Promise<{ email: string; apiKey: string } | null> {
  if (botEmail) {
    const local = getBotKeyByEmail(botEmail)
    if (local) return local
  }
  if (!s3ForConfig || !commandName) return null
  try {
    const key = botS3ConfigKey(commandName)
    const res = await s3ForConfig.send(new GetObjectCommand({ Bucket: BOTS_S3_BUCKET, Key: key }))
    const cfg = JSON.parse(await res.Body!.transformToString("utf-8"))
    if (cfg.zulip_api_key) return { email: cfg.zulip_email ?? botEmail ?? "", apiKey: cfg.zulip_api_key }
  } catch {}
  if (botEmail && s3ForConfig) {
    try {
      const { ListObjectsV2Command } = await import("@aws-sdk/client-s3")
      const list = await s3ForConfig.send(new ListObjectsV2Command({ Bucket: BOTS_S3_BUCKET, Prefix: "bot-prompts/" }))
      for (const item of list.Contents ?? []) {
        if (!item.Key?.endsWith("/config.json")) continue
        const dr = await s3ForConfig.send(new GetObjectCommand({ Bucket: BOTS_S3_BUCKET, Key: item.Key }))
        const dc = JSON.parse(await dr.Body!.transformToString("utf-8"))
        if (dc.zulip_email === botEmail && dc.zulip_api_key) return { email: dc.zulip_email, apiKey: dc.zulip_api_key }
      }
    } catch {}
  }
  return null
}

function getBotKeyByEmail(botEmail: string): { email: string; apiKey: string } | null {
  if (!botEmail) return null
  try {
    const botsPath = path.join(LEGION_DIR, "bots.jsonc")
    const raw = JSON.parse(fs.readFileSync(botsPath, "utf-8"))
    const bot = (raw.bots ?? []).find((b: any) => b.zulip_email === botEmail)
    if (bot?.zulip_api_key) return { email: bot.zulip_email, apiKey: bot.zulip_api_key }
  } catch {}
  return null
}

export async function learnBotToken(commandName: string, token: string, botEmail?: string): Promise<void> {
  if (!token) return
  const botKey = await getBotApiKey(commandName, botEmail)
  if (!botKey) return
  const s3key = botS3ConfigKey(commandName)
  if (!s3ForConfig) return
  try {
    const res = await s3ForConfig.send(new GetObjectCommand({ Bucket: BOTS_S3_BUCKET, Key: s3key }))
    const text = await res.Body!.transformToString("utf-8")
    const config = JSON.parse(text)
    if (!config.service_tokens) config.service_tokens = []
    if (!config.service_tokens.includes(token)) {
      config.service_tokens.push(token)
      await s3ForConfig.send(new PutObjectCommand({
        Bucket: BOTS_S3_BUCKET,
        Key: s3key,
        Body: JSON.stringify(config, null, 2),
        ContentType: "application/json",
      }))
    }
  } catch {}
}

const S3_COMMANDS_DIR = process.env.LEGION_PROJECT_DIR
  ? path.join(process.env.LEGION_PROJECT_DIR, ".legion", "command")
  : ""

export async function syncPromptsFromS3(): Promise<number> {
  if (!s3ForConfig || !S3_COMMANDS_DIR) return 0
  let count = 0
  try {
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3")
    const res = await s3ForConfig.send(new ListObjectsV2Command({
      Bucket: BOTS_S3_BUCKET,
      Prefix: "bot-prompts/",
    }))
    for (const item of res.Contents ?? []) {
      if (!item.Key?.endsWith("/prompt.md")) continue
      const name = item.Key.replace("bot-prompts/", "").replace("/prompt.md", "")
      const promptRes = await s3ForConfig.send(new GetObjectCommand({ Bucket: BOTS_S3_BUCKET, Key: item.Key }))
      const text = await promptRes.Body!.transformToString("utf-8")
      const localPath = path.join(S3_COMMANDS_DIR, `${name}.md`)
      fs.mkdirSync(path.dirname(localPath), { recursive: true })
      fs.writeFileSync(localPath, text, "utf-8")
      count++
    }
  } catch {}
  return count
}
