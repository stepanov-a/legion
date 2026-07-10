// Промежуточный слой (middleware), который предоставляет InstanceRef
// для webhook-запросов (публичные эндпоинты без авторизации).
//
// Зачем: InstanceRef нужен всем сервисам opencode (Config, Command, Provider,
// SessionPrompt). Обычный instanceContextLayer требует WorkspaceRouteContext
// (директория из URL), но у /zulip/webhook нет workspace в URL.
// Эта middleware загружает InstanceRef для фиксированной директории PROJECT_ROOT.

import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Effect, Layer } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"

const PROJECT_DIR = process.env.LEGION_PROJECT_DIR ?? process.cwd()

// Класс-маркер middleware. Effect использует его для идентификации.
export class WebhookContextMiddleware extends HttpApiMiddleware.Service<
  WebhookContextMiddleware
>()("@opencode/WebhookContextMiddleware") {}

// Layer создаёт экземпляр middleware.
// store.load читает конфиг проекта и возвращает InstanceContext.
// Если загрузка не удалась — middleware пропускает запрос без InstanceRef
// (обработчик продолжает работать с дефолтами).
export const webhookContextLayer = Layer.effect(
  WebhookContextMiddleware,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return WebhookContextMiddleware.of((effect) =>
      store.load({ directory: PROJECT_DIR }).pipe(
        Effect.andThen((ctx) => effect.pipe(Effect.provideService(InstanceRef, ctx))),
        Effect.catch(() => effect),
      ),
    )
  }),
)
