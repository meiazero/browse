import WebSocket from "ws"
import { relayLog } from "./log.ts"

type Command = { id: number; method: string; params: Record<string, unknown> }
type Message = {
  id: number
  type: string
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
  message?: string
}

export function createBidiGuard(options: {
  readonly endpoint: string
  readonly isAdoptedContext?: (sessionId: string, context: string) => boolean
  readonly log?: typeof relayLog
  readonly cleanupTimeoutMs?: number
}) {
  const endpoint = new URL(options.endpoint)
  if (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") throw new Error("BiDi requires a ws:// or wss:// endpoint")
  const log = options.log ?? relayLog
  let stopped = false
  let active: { close: () => Promise<void> } | undefined

  return {
    get busy(): boolean { return active !== undefined },
    // The caller authenticates the socket and supplies its session identity; wire messages cannot grant ownership.
    accept(client: WebSocket, sessionId?: string): void {
      if (stopped || active) {
        client.on("error", () => {})
        client.close(1013, stopped ? "BiDi relay is stopping" : "BiDi relay already has a client")
        return
      }

      const upstream = new WebSocket(endpoint, { handshakeTimeout: 5_000 })
      const created = new Set<string>()
      const pending = new Map<number, Command>()
      const clientIds = new Set<number>()
      const queue: string[] = []
      let nextId = 0
      let session: "none" | "starting" | "active" | "ending" = "none"
      let draining = false
      let finished = false
      let failure: Error | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let resolveClosed!: () => void
      const closed = new Promise<void>((resolve) => { resolveClosed = resolve })
      const restartAdvice = "Restart Firefox/Zen to release its BiDi session, then reconnect."

      const reply = (message: unknown) => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message))
      }
      const reject = (id: number | null, error: string, message: string) => reply({ type: "error", id, error, message })
      const finish = (error?: Error) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        failure ??= error
        if (failure) log("bidi.error", { message: failure.message })
        upstream.terminate()
        client.close(failure ? 1011 : 1000, failure ? "BiDi connection failed; check relay diagnostics" : "BiDi session ended")
        pending.clear()
        clientIds.clear()
        created.clear()
        active = undefined
        resolveClosed()
      }
      const send = (method: string, params: Record<string, unknown>, command?: Command) => {
        const id = ++nextId
        if (!command) log("bidi.command", { method })
        pending.set(id, command ?? { id: -1, method, params })
        if (command) clientIds.add(command.id)
        const raw = JSON.stringify({ id, method, params })
        if (upstream.readyState === WebSocket.OPEN) upstream.send(raw)
        else queue.push(raw)
      }
      const endSession = () => {
        if (session === "none") return finish()
        if (session !== "active") return
        session = "ending"
        send("session.end", {})
      }
      const close = async () => {
        if (!draining && !finished) {
          draining = true
          timer = setTimeout(() => finish(new Error(`BiDi session cleanup timed out. ${restartAdvice}`)), options.cleanupTimeoutMs ?? 5_000)
          if (upstream.readyState === WebSocket.CONNECTING) finish()
          else endSession()
        }
        await closed
        if (failure) throw failure
      }
      active = { close }
      const disconnect = () => { void close().catch(() => {}) }

      upstream.on("open", () => {
        for (const raw of queue.splice(0)) upstream.send(raw)
      })
      upstream.on("error", () => finish(new Error(`BiDi upstream connection failed. ${restartAdvice}`)))
      upstream.on("close", () => finish(session === "none" ? undefined : new Error(`BiDi upstream disconnected before session.end completed. ${restartAdvice}`)))
      upstream.on("message", (data) => {
        let message: Message
        try {
          message = JSON.parse(String(data))
          if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error()
        } catch {
          failure = new Error("Invalid BiDi upstream message")
          disconnect()
          return
        }
        if (message.type === "event") {
          if (message.method === "browsingContext.contextDestroyed" && typeof message.params?.context === "string") created.delete(message.params.context)
          if (!draining) reply(message)
          return
        }
        const command = pending.get(message.id)
        if (!command || (message.type !== "success" && message.type !== "error")) return
        pending.delete(message.id)
        clientIds.delete(command.id)
        const success = message.type === "success"
        if (command.method === "session.new") {
          session = success ? "active" : "none"
          if (!success && (message.error === "session not created" || /Maximum number of active sessions/i.test(message.message ?? ""))) {
            message.message = `Firefox/Zen refused a new BiDi session. ${restartAdvice}`
          }
        }
        if (command.method === "session.end") {
          session = success ? "none" : "active"
          if (success) created.clear()
          if (draining && !success) failure = new Error(`BiDi session.end failed. ${restartAdvice}`)
        }
        if (success && command.method === "browsingContext.create" && typeof message.result?.context === "string") created.add(message.result.context)
        if (success && command.method === "browsingContext.close") created.delete(String(command.params.context))
        if (!draining && command.id >= 0) reply({ ...message, id: command.id })
        if (success && command.method === "session.end") return finish()
        if (draining) {
          if (failure && command.method === "session.end") finish()
          else endSession()
        }
      })

      client.on("message", (data, binary) => {
        if (draining || finished) return
        let command: Command
        try {
          command = JSON.parse(String(data))
          if (binary || !command || !Number.isSafeInteger(command.id) || command.id < 0 ||
            typeof command.method !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]*\.[a-zA-Z][a-zA-Z0-9_]*$/.test(command.method) ||
            !command.params || typeof command.params !== "object" || Array.isArray(command.params)) throw new Error()
        } catch {
          reject(null, "invalid argument", "Expected a BiDi command with an unsigned integer id, method and params object")
          return
        }
        const { id, method, params } = command
        log("bidi.command", { method })
        if (method === "browser.close") {
          reply({ type: "success", id, result: {} })
          return
        }
        if (clientIds.has(id)) {
          reject(id, "invalid argument", "BiDi command id is already pending")
          return
        }
        let denial: string | undefined
        if (method === "session.new" && session !== "none") denial = "This relay already owns a BiDi session"
        else if (method !== "session.new" && method !== "session.status" && session !== "active") denial = "This relay has no active BiDi session"
        // Removing a user context also closes its tabs, bypassing browsingContext.close.
        else if (method === "browser.removeUserContext") denial = "Cannot remove user contexts from an attached browser"
        else if (method === "browsingContext.close") {
          const context = params.context
          let adopted = false
          if (typeof context === "string" && sessionId) {
            try { adopted = options.isAdoptedContext?.(sessionId, context) === true } catch { /* Failed ownership checks deny closing. */ }
          }
          if (typeof context !== "string" || (!created.has(context) && !adopted)) denial = "Cannot close a tab this relay did not create or adopt through a session"
        }
        if (denial) {
          reject(id, "unsupported operation", denial)
          return
        }
        if (method === "session.new") {
          session = "starting"
          created.clear()
        }
        if (method === "session.end") session = "ending"
        send(method, params, command)
      })
      client.on("close", disconnect)
      client.on("error", disconnect)
    },
    async close(): Promise<void> {
      stopped = true
      await active?.close()
    },
  }
}
