import { afterEach, expect, test } from "bun:test"
import type { AddressInfo } from "node:net"
import WebSocket, { WebSocketServer } from "ws"
import { createBidiGuard } from "../src/relay/bidi-guard.ts"

type Command = { id: number; method: string; params: Record<string, unknown> }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error("BiDi test condition timed out")
}

async function fixture(options: {
  rejectSession?: boolean
  sessionDelay?: number
  endDelay?: number
  failCreate?: boolean
  stallEnd?: boolean
  failEnd?: boolean
  sessionId?: string
  isAdoptedContext?: (sessionId: string, context: string) => boolean
} = {}) {
  const remote = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await new Promise<void>((resolve) => remote.once("listening", resolve))
  const commands: Command[] = []
  const logs: { event: string; fields: Record<string, unknown> }[] = []
  const tabs = new Set(["user-tab"])
  let sessionActive = false
  let leaked = false
  let connections = 0
  let nextContext = 0
  const event = (method: string, params: unknown) => {
    for (const socket of remote.clients) socket.send(JSON.stringify({ type: "event", method, params }))
  }
  remote.on("connection", (socket) => {
    connections++
    let ownsSession = false
    socket.on("close", () => { leaked ||= ownsSession })
    socket.on("message", (data) => {
      const command = JSON.parse(String(data)) as Command
      commands.push(command)
      const reply = (result: unknown = {}) => socket.send(JSON.stringify({ type: "success", id: command.id, result }))
      const fail = (error: string, message: string) => socket.send(JSON.stringify({ type: "error", id: command.id, error, message }))
      switch (command.method) {
        case "session.new": {
          if (sessionActive || options.rejectSession) return fail("session not created", "Maximum number of active sessions")
          const acquire = () => {
            sessionActive = ownsSession = true
            reply({ sessionId: "bidi-session", capabilities: {} })
          }
          if (options.sessionDelay) setTimeout(acquire, options.sessionDelay)
          else acquire()
          return
        }
        case "session.end": {
          if (options.stallEnd) return
          if (options.failEnd) return fail("unknown error", "upstream-secret")
          const release = () => { sessionActive = ownsSession = false; reply() }
          if (options.endDelay) setTimeout(release, options.endDelay)
          else release()
          return
        }
        case "browsingContext.create": {
          if (options.failCreate) return fail("unknown error", "Injected creation failure")
          const context = `created-${++nextContext}`
          tabs.add(context)
          event("browsingContext.contextCreated", { context })
          return reply({ context })
        }
        case "browsingContext.close":
          tabs.delete(String(command.params.context))
          return reply()
        default:
          return reply({ echoed: command.params })
      }
    })
  })
  const endpoint = `ws://127.0.0.1:${(remote.address() as AddressInfo).port}/session`
  const guard = createBidiGuard({
    endpoint,
    cleanupTimeoutMs: 200,
    log: (event, fields = {}) => { logs.push({ event, fields }) },
    ...(options.isAdoptedContext ? { isAdoptedContext: options.isAdoptedContext } : {}),
  })
  const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  relay.on("connection", (socket) => guard.accept(socket, options.sessionId))
  await new Promise<void>((resolve) => relay.once("listening", resolve))
  const relayEndpoint = `ws://127.0.0.1:${(relay.address() as AddressInfo).port}/session`
  cleanups.push(async () => {
    await guard.close().catch(() => {})
    for (const server of [relay, remote]) {
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  const connect = async () => {
    const socket = new WebSocket(relayEndpoint)
    const events: unknown[] = []
    const waiters = new Map<number, (response: any) => void>()
    let nextId = 0
    const closed = new Promise<number>((resolve) => socket.once("close", resolve))
    socket.on("message", (data) => {
      const response = JSON.parse(String(data))
      if (response.type === "event") events.push(response)
      else waiters.get(response.id)?.(response)
    })
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject) })
    return {
      socket, closed, events,
      send(method: string, params: Record<string, unknown> = {}, id = ++nextId): Promise<any> {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`BiDi test response timed out: ${method}`)) }, 1_000)
          waiters.set(id, (response) => { clearTimeout(timer); waiters.delete(id); resolve(response) })
          socket.send(JSON.stringify({ id, method, params }))
        })
      },
    }
  }
  return { guard, connect, commands, logs, tabs, event, remote,
    get sessionActive() { return sessionActive }, get leaked() { return leaked }, get connections() { return connections },
  }
}

test("forwards commands and events, drops browser.close independently of the client, and logs no params", async () => {
  const f = await fixture()
  const client = await f.connect()
  expect(await client.send("browser.close")).toEqual({ type: "success", id: 1, result: {} })
  await client.send("session.new", { capabilities: {} })
  expect(await client.send("script.evaluate", { expression: "secret-password" }, 900)).toEqual({ type: "success", id: 900, result: { echoed: { expression: "secret-password" } } })
  f.event("browsingContext.load", { context: "user-tab", url: "secret-url" })
  await until(() => client.events.length === 1)
  expect(await client.send("browser.close")).toMatchObject({ type: "success", result: {} })
  expect(f.sessionActive).toBe(true)
  expect(f.commands.some(({ method }) => method === "browser.close")).toBe(false)
  expect(f.logs.map(({ fields }) => fields.method)).toEqual(["browser.close", "session.new", "script.evaluate", "browser.close"])
  expect(JSON.stringify(f.logs)).not.toContain("secret")
  expect(f.logs.every(({ fields }) => Object.keys(fields).join() === "method")).toBe(true)
  await f.guard.close()
  expect(f.logs.at(-1)?.fields).toEqual({ method: "session.end" })
  expect(f.sessionActive).toBe(false)
  expect(f.leaked).toBe(false)
})

test("only successful creation grants close permission; existing tabs and user contexts stay protected", async () => {
  const f = await fixture()
  const client = await f.connect()
  await client.send("session.new")
  expect(await client.send("browsingContext.close", { context: "user-tab" })).toMatchObject({ type: "error", error: "unsupported operation" })
  expect(await client.send("browser.removeUserContext", { userContext: "default" })).toMatchObject({ type: "error" })
  f.event("browsingContext.contextCreated", { context: "user-tab" })
  expect(await client.send("browsingContext.close", { context: "user-tab" })).toMatchObject({ type: "error" })
  const { result } = await client.send("browsingContext.create", { type: "tab" })
  expect(await client.send("browsingContext.close", { context: result.context })).toMatchObject({ type: "success" })
  expect(await client.send("browsingContext.close", { context: result.context })).toMatchObject({ type: "error" })
  const second = await client.send("browsingContext.create", { type: "tab" })
  f.event("browsingContext.contextDestroyed", { context: second.result.context })
  expect(await client.send("browsingContext.close", { context: second.result.context })).toMatchObject({ type: "error" })
  expect(f.commands.filter(({ method }) => method === "browsingContext.close").map(({ params }) => params.context)).toEqual([result.context])
  expect(f.commands.some(({ method }) => method === "browser.removeUserContext")).toBe(false)
  expect(f.tabs.has("user-tab")).toBe(true)
})

test("failed creates and duplicate request ids cannot forge ownership", async () => {
  const f = await fixture({ failCreate: true, sessionDelay: 30 })
  const client = await f.connect()
  const starting = client.send("session.new", {}, 10)
  expect(await client.send("browsingContext.create", { type: "tab" }, 11)).toMatchObject({ type: "error" })
  // Raw duplication leaves the original waiter's response observable.
  client.socket.send(JSON.stringify({ id: 10, method: "browsingContext.create", params: { type: "tab" } }))
  expect(await starting).toMatchObject({ type: "error", message: "BiDi command id is already pending" })
  await until(() => f.sessionActive)
  expect(await client.send("browsingContext.create", { type: "tab" }, 12)).toMatchObject({ type: "error", message: "Injected creation failure" })
  expect(await client.send("browsingContext.close", { context: "user-tab" }, 13)).toMatchObject({ type: "error" })
  expect(f.commands.map(({ method }) => method)).toEqual(["session.new", "browsingContext.create"])
})

test("adoption requires the server's session identity and a current ownership check", async () => {
  let adopted = false
  const f = await fixture({ sessionId: "trusted", isAdoptedContext: (session, context) => adopted && session === "trusted" && context === "user-tab" })
  const client = await f.connect()
  await client.send("session.new")
  expect(await client.send("browsingContext.close", { context: "user-tab", sessionId: "trusted", adopted: true })).toMatchObject({ type: "error" })
  adopted = true
  expect(await client.send("browsingContext.close", { context: "user-tab" })).toMatchObject({ type: "success" })
  adopted = false
  expect(await client.send("browsingContext.close", { context: "user-tab" })).toMatchObject({ type: "error" })
})

test("an adoption callback cannot authorize an anonymous client", async () => {
  const f = await fixture({ isAdoptedContext: () => true })
  const client = await f.connect()
  await client.send("session.new")
  expect(await client.send("browsingContext.close", { context: "user-tab", sessionId: "forged" })).toMatchObject({ type: "error" })
})

test("disconnect ends the session and the next client starts with no inherited close permissions", async () => {
  const f = await fixture()
  const client = await f.connect()
  await client.send("session.new")
  const created = await client.send("browsingContext.create", { type: "tab" })
  client.socket.terminate()
  await until(() => !f.sessionActive)
  const next = await f.connect()
  expect(await next.send("session.new")).toMatchObject({ type: "success" })
  expect(await next.send("browsingContext.close", { context: created.result.context })).toMatchObject({ type: "error" })
  await f.guard.close()
  expect(f.commands.filter(({ method }) => method === "session.end")).toHaveLength(2)
  expect(f.tabs.has("user-tab")).toBe(true)
  expect(f.leaked).toBe(false)
})

test("disconnect during session.new waits for acquisition before ending the session", async () => {
  const f = await fixture({ sessionDelay: 30 })
  const client = await f.connect()
  client.socket.send(JSON.stringify({ id: 1, method: "session.new", params: {} }))
  await until(() => f.commands.length === 1)
  client.socket.terminate()
  await until(() => f.commands.some(({ method }) => method === "session.end"))
  await until(() => !f.sessionActive)
  expect(f.commands.map(({ method }) => method)).toEqual(["session.new", "session.end"])
  expect(f.leaked).toBe(false)
})

test("shutdown waits for an in-flight session.end without sending a duplicate", async () => {
  const f = await fixture({ endDelay: 30 })
  const client = await f.connect()
  await client.send("session.new")
  client.socket.send(JSON.stringify({ id: 2, method: "session.end", params: {} }))
  await until(() => f.commands.some(({ method }) => method === "session.end"))
  await f.guard.close()
  expect(f.sessionActive).toBe(false)
  expect(f.commands.map(({ method }) => method)).toEqual(["session.new", "session.end"])
  expect(await client.closed).toBe(1000)
})

test("a second client cannot occupy or end the first client's session", async () => {
  const f = await fixture()
  const first = await f.connect()
  await first.send("session.new")
  const second = await f.connect()
  expect(await second.closed).toBe(1013)
  expect(f.connections).toBe(1)
  expect(f.sessionActive).toBe(true)
  await first.send("session.end")
  first.socket.close()
  await first.closed
  expect(f.commands.map(({ method }) => method)).toEqual(["session.new", "session.end"])
})

test("a stuck slot reports restart advice once and never ends a session it did not acquire", async () => {
  const f = await fixture({ rejectSession: true })
  const client = await f.connect()
  expect(await client.send("session.new")).toMatchObject({ type: "error", error: "session not created", message: expect.stringContaining("Restart Firefox/Zen") })
  await f.guard.close()
  expect(f.commands.map(({ method }) => method)).toEqual(["session.new"])
})

test("cleanup timeouts and upstream loss report restart advice without hanging shutdown", async () => {
  const f = await fixture({ stallEnd: true })
  const client = await f.connect()
  await client.send("session.new")
  await expect(f.guard.close()).rejects.toThrow("cleanup timed out")
  expect(f.logs.at(-1)).toMatchObject({ event: "bidi.error", fields: { message: expect.stringContaining("Restart Firefox/Zen") } })
  expect(f.commands.map(({ method }) => method)).toEqual(["session.new", "session.end"])

  const lost = await fixture()
  const next = await lost.connect()
  await next.send("session.new")
  for (const socket of lost.remote.clients) socket.terminate()
  expect(await next.closed).toBe(1011)
  expect(lost.logs.at(-1)?.fields.message).toContain("Restart Firefox/Zen")
})

test("malformed commands cannot reach the upstream and an unowned session cannot be ended", async () => {
  const f = await fixture()
  const client = await f.connect()
  expect(await client.send("session.end")).toMatchObject({ type: "error" })
  const response = new Promise<any>((resolve) => client.socket.once("message", (data) => resolve(JSON.parse(String(data)))))
  client.socket.send("[]")
  expect(await response).toMatchObject({ type: "error", error: "invalid argument" })
  expect(f.commands).toHaveLength(0)
  await f.guard.close()
})

test("malformed upstream data still triggers session.end and keeps raw data out of diagnostics", async () => {
  const f = await fixture()
  const client = await f.connect()
  await client.send("session.new")
  for (const socket of f.remote.clients) socket.send("{upstream-secret")
  expect(await client.closed).toBe(1011)
  expect(f.commands.map(({ method }) => method)).toEqual(["session.new", "session.end"])
  expect(f.sessionActive).toBe(false)
  expect(f.leaked).toBe(false)
  expect(JSON.stringify(f.logs)).not.toContain("upstream-secret")
})

test("a failed session.end reports the stuck slot without logging the upstream error payload", async () => {
  const f = await fixture({ failEnd: true })
  const client = await f.connect()
  await client.send("session.new")
  await expect(f.guard.close()).rejects.toThrow("session.end failed")
  expect(await client.closed).toBe(1011)
  expect(f.commands.map(({ method }) => method)).toEqual(["session.new", "session.end"])
  expect(JSON.stringify(f.logs)).not.toContain("upstream-secret")
})
