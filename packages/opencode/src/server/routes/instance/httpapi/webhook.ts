// Сборка публичного webhook API.
// PublicWebhookApi — HttpApi без аутентификации.
// Содержит универсальный эндпоинт POST /webhook/:source.
import { HttpApi } from "effect/unstable/httpapi"
import { WebhookApi } from "./groups/webhook"

export const PublicWebhookApi = HttpApi.make("opencode-webhook").addHttpApi(WebhookApi)
