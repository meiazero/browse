import { describe, expect, test } from "bun:test"
import type { AddressInfo } from "node:net"
import { chromium, firefox } from "patchright-core"
import { WebSocketServer, type WebSocket } from "ws"

type Command = { id: number; method: string; params: Record<string, unknown> }

async function fakeBiDi(options: { tabs?: string[]; fail?: string; stall?: string; sessionDelay?: number; rejectSession?: boolean } = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const commands: Command[] = []
  const tabs = new Set(options.tabs ?? ["existing"])
  let active = false
  let leaked = false
  let nextId = 0
  const event = (socket: WebSocket, method: string, params: unknown) => socket.send(JSON.stringify({ type: "event", method, params }))
  const created = (socket: WebSocket, context: string) => {
    event(socket, "browsingContext.contextCreated", {
      context, url: `https://example.test/${context}`, userContext: "default", parent: null, children: null, originalOpener: null,
    })
    event(socket, "script.realmCreated", { context, realm: `realm-${context}`, type: "window", origin: "https://example.test" })
  }
  server.on("connection", (socket) => {
    let ownsSession = false
    socket.on("close", () => { leaked ||= ownsSession })
    socket.on("message", (data) => {
      const command = JSON.parse(String(data)) as Command
      commands.push(command)
      const reply = (result: unknown = {}) => socket.send(JSON.stringify({ type: "success", id: command.id, result }))
      const fail = (message: string) => socket.send(JSON.stringify({ type: "error", id: command.id, error: "unknown error", message }))
      if (command.method === options.stall) return
      if (command.method === options.fail) return fail("Injected initialization failure")
      switch (command.method) {
        case "session.new": {
          if (active || options.rejectSession) return fail("Maximum number of active sessions")
          const start = () => {
            active = ownsSession = true
            reply({ sessionId: "test", capabilities: { browserVersion: "159.0", userAgent: "Firefox/159.0" } })
          }
          if (options.sessionDelay) setTimeout(start, options.sessionDelay)
          else start()
          return
        }
        case "session.end":
          active = ownsSession = false
          return reply()
        case "session.subscribe":
          for (const context of tabs) created(socket, context)
          return reply({ subscription: "subscription" })
        case "browsingContext.create": {
          const context = `owned-${++nextId}`
          tabs.add(context)
          created(socket, context)
          return reply({ context })
        }
        case "browsingContext.close": {
          const context = String(command.params.context)
          tabs.delete(context)
          event(socket, "browsingContext.contextDestroyed", { context, parent: null })
          return reply()
        }
        case "script.addPreloadScript":
          return reply({ script: `script-${++nextId}` })
        case "script.evaluate":
          return reply({ type: "success", realm: "utility", result: command.params.expression === "1 + 1" ? { type: "number", value: 2 } : { type: "object", handle: "injected" } })
        case "script.callFunction":
          return reply({ type: "success", result: { type: "undefined" } })
        default:
          return reply()
      }
    })
  })
  return {
    endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/session`,
    commands,
    tabs,
    get active() { return active },
    get leaked() { return leaked },
    async close() {
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function expectSafe(commands: Command[]) {
  expect(commands.some(({ method }) => method === "browser.close")).toBe(false)
  expect(commands.some(({ method }) => method === "browser.setDownloadBehavior")).toBe(false)
  expect(commands.some(({ method }) => method === "emulation.setMediaFeaturesOverride")).toBe(false)
  expect(commands.filter(({ method }) => method === "browsingContext.close").every(({ params }) => String(params.context).startsWith("owned-"))).toBe(true)
}

describe("Firefox connectOverBiDi patch", () => {
  test("requires Firefox and a WebSocket endpoint", async () => {
    await expect(chromium.connectOverBiDi("ws://unused.invalid")).rejects.toThrow("only supported by Firefox")
    await expect(firefox.connectOverBiDi("https://unused.invalid")).rejects.toThrow("requires a ws:// or wss:// endpoint")
  })

  test("adopts loaded tabs, creates only tabs, preserves existing tabs and releases the session", async () => {
    const remote = await fakeBiDi({ tabs: ["existing", "second"] })
    try {
      const browser = await firefox.connectOverBiDi(remote.endpoint, { timeout: 2_000 })
      try {
        const context = browser.contexts()[0]!
        expect(context.pages().map((page) => page.url())).toEqual(["https://example.test/existing", "https://example.test/second"])
        expect(remote.commands.filter(({ method }) => method === "browsingContext.create")).toHaveLength(0)
        for (const page of context.pages()) {
          await page.waitForLoadState("domcontentloaded", { timeout: 100 })
          await page.waitForLoadState("load", { timeout: 100 })
        }
        await expect(context.pages()[0]!.close()).rejects.toThrow("did not create")
        await expect(context.pages()[1]!.close({ runBeforeUnload: true })).rejects.toThrow("did not create")
        const page = await context.newPage()
        expect(remote.commands.find(({ method }) => method === "browsingContext.create")?.params.type).toBe("tab")
        await page.close()
        expect([...remote.tabs]).toEqual(["existing", "second"])
      } finally {
        await browser.close()
      }
      expect(remote.active).toBe(false)
      expect(remote.leaked).toBe(false)
      const again = await firefox.connectOverBiDi(remote.endpoint, { timeout: 2_000 })
      await again.contexts()[0]!.close()
      expect(remote.commands.filter(({ method }) => method === "session.end")).toHaveLength(2)
      expect([...remote.tabs]).toEqual(["existing", "second"])
      expect(remote.active).toBe(false)
      expectSafe(remote.commands)
    } finally {
      await remote.close()
    }
  })

  test("creates one owned tab when the browser has no loaded tabs", async () => {
    const remote = await fakeBiDi({ tabs: [] })
    try {
      const browser = await firefox.connectOverBiDi(remote.endpoint, { timeout: 2_000 })
      try {
        expect(browser.contexts()[0]!.pages()).toHaveLength(1)
        await browser.contexts()[0]!.pages()[0]!.close()
        expect(remote.tabs.size).toBe(0)
      } finally {
        await browser.close()
      }
      expectSafe(remote.commands)
    } finally {
      await remote.close()
    }
  })

  for (const options of [{ fail: "network.addDataCollector" }, { stall: "network.addDataCollector" }, { sessionDelay: 150 }]) {
    test(`ends its session after attach failure: ${JSON.stringify(options)}`, async () => {
      const remote = await fakeBiDi(options)
      try {
        await expect(firefox.connectOverBiDi(remote.endpoint, { timeout: 100 })).rejects.toThrow()
        expect(remote.commands.filter(({ method }) => method === "session.end")).toHaveLength(1)
        expect(remote.active).toBe(false)
        expect(remote.leaked).toBe(false)
        expect([...remote.tabs]).toEqual(["existing"])
        expectSafe(remote.commands)
      } finally {
        await remote.close()
      }
    })
  }

  test("does not end a session it failed to acquire", async () => {
    const remote = await fakeBiDi({ rejectSession: true })
    try {
      await expect(firefox.connectOverBiDi(remote.endpoint, { timeout: 2_000 })).rejects.toThrow("Maximum number of active sessions")
      expect(remote.commands.map(({ method }) => method)).toEqual(["session.new"])
      expectSafe(remote.commands)
    } finally {
      await remote.close()
    }
  })
})
