// Универсальный эндпоинт для всех вебхуков.
// POST /webhook/:source — source берётся из URL.
// POST /webhook/reload — сброс кэша команд/конфига (без перезапуска).
// Payload: Schema.Unknown (любой JSON).
// Response: { content: string }.

import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"
import { WebhookContextMiddleware } from "../middleware/webhook-context"

const root = "/webhook"

const WebhookParams = Schema.Struct({
  source: Schema.String,
})

const WebhookBody = Schema.Unknown

export const WebhookApi = HttpApi.make("opencode-webhook").add(
  HttpApiGroup.make("webhooks")
    .add(
      HttpApiEndpoint.post("ingress", `${root}/:source`, {
        params: WebhookParams,
        payload: WebhookBody,
        success: Schema.Struct({ content: Schema.String }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "webhook.ingress",
          summary: "Universal webhook ingress",
          description: "Receives webhooks from any source (zulip, telegram, etc.). Source name in URL.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("reload", `${root}/reload`, {
        success: Schema.Struct({ content: Schema.String }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "webhook.reload",
          summary: "Reload webhook config cache",
          description: "Flushes config/command cache and re-reads from disk. Use after git pull.",
        }),
      ),
    )
    .middleware(WebhookContextMiddleware)
    .annotateMerge(OpenApi.annotations({ title: "webhooks", description: "Universal webhook ingress routes." })),
)
