process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
import { Server } from "./packages/opencode/src/server/server"
const s = await Server.listen({ port: 3000, hostname: "0.0.0.0" })
console.log(`listening on ${s.hostname}:${s.port}`)
await new Promise(() => {})
