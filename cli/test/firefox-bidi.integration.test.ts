import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { firefox, type Browser } from "patchright-core"
import WebSocket, { WebSocketServer } from "ws"
import { createBidiGuard } from "../src/relay/bidi-guard.ts"

async function freeFirefoxPort() {
  for (let port = 19300; port <= 19399; port++) {
    const server = net.createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, "::", resolve)
      })
      await new Promise<void>((resolve) => server.close(() => resolve()))
      return port
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error
    }
  }
  throw new Error("No free Firefox test port in 19300-19399")
}

async function seedTab(endpoint: string, url: string) {
  const socket = new WebSocket(endpoint)
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let nextId = 0
  socket.on("message", (data) => {
    const message = JSON.parse(String(data))
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.type === "error") waiter.reject(new Error(message.message))
    else waiter.resolve(message.result)
  })
  socket.on("close", () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error("Firefox test socket closed"))
    }
    pending.clear()
  })
  const send = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Firefox test command timed out: ${method}`))
    }, 3_000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })
  let acquired = false
  try {
    await send("session.new", { capabilities: {} })
    acquired = true
    const { contexts } = await send("browsingContext.getTree", { maxDepth: 0 })
    const context = contexts[0]?.context ?? (await send("browsingContext.create", { type: "tab" })).context
    await send("browsingContext.navigate", { context, url, wait: "complete" })
    return url
  } finally {
    try {
      if (acquired) await send("session.end")
    } finally {
      socket.close()
    }
  }
}

// Opt-in keeps the normal suite independent of a system Firefox installation.
test.skipIf(process.env.BROWSE_TEST_FIREFOX_BIDI !== "1")("attaches to an isolated Firefox and preserves tabs across sessions", async () => {
  const port = await freeFirefoxPort()
  const profile = mkdtempSync(path.join(os.tmpdir(), "browse-firefox-test-"))
  const child = spawn("/usr/bin/firefox", ["--headless", "--profile", profile, `--remote-debugging-port=${port}`, "--no-remote"], { stdio: ["ignore", "pipe", "pipe"] })
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()))
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 40_000)
  const content = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: (request) => new Response(`<title>${new URL(request.url).pathname === "/preserved" ? "Preserved" : "Owned"} test tab</title>`, { headers: { "content-type": "text/html" } }),
  })
  let browser: Browser | undefined
  let guard: ReturnType<typeof createBidiGuard> | undefined
  let proxy: WebSocketServer | undefined
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Isolated Firefox did not announce its BiDi endpoint")), 15_000)
      let output = ""
      const read = (data: Buffer) => {
        output += String(data)
        const match = output.match(/WebDriver BiDi listening on (ws:\/\/\S+)/)
        if (!match) return
        const url = new URL(match[1]!)
        if (url.port !== String(port) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
          clearTimeout(timer)
          reject(new Error(`Unexpected isolated Firefox endpoint: ${url}`))
          return
        }
        url.pathname = "/session"
        clearTimeout(timer)
        resolve(String(url))
      }
      child.stderr.on("data", read)
      child.stdout.on("data", read)
      child.once("error", (error) => { clearTimeout(timer); reject(error) })
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`Isolated Firefox exited: ${output}`)) })
    })
    const url = await seedTab(endpoint, new URL("/preserved", content.url).href)
    const methods: string[] = []
    guard = createBidiGuard({ endpoint, log: (event, fields) => {
      if (event === "bidi.command") methods.push(String(fields?.method))
    } })
    proxy = new WebSocketServer({ host: "127.0.0.1", port: 0 })
    proxy.on("connection", (socket) => guard!.accept(socket))
    await new Promise<void>((resolve) => proxy!.once("listening", resolve))
    const guardedEndpoint = `ws://127.0.0.1:${(proxy.address() as net.AddressInfo).port}/session`
    browser = await firefox.connectOverBiDi(guardedEndpoint, { timeout: 10_000 })
    const context = browser.contexts()[0]!
    const original = context.pages().find((page) => page.url() === url)!
    expect(original).toBeDefined()
    expect(await original.title()).toBe("Preserved test tab")
    await original.waitForLoadState("load", { timeout: 500 })
    const originalURLs = context.pages().map((page) => page.url())
    const page = await context.newPage()
    await page.goto(new URL("/owned", content.url).href)
    expect(await page.title()).toBe("Owned test tab")
    await page.close()
    await expect(original.close()).rejects.toThrow("did not create")
    await browser.close()
    expect(child.exitCode).toBeNull()
    browser = await firefox.connectOverBiDi(guardedEndpoint, { timeout: 10_000 })
    expect(browser.contexts()[0]!.pages().map((tab) => tab.url())).toEqual(originalURLs)
    expect(await browser.contexts()[0]!.pages().find((tab) => tab.url() === url)!.title()).toBe("Preserved test tab")
    await browser.contexts()[0]!.close()
    browser = await firefox.connectOverBiDi(guardedEndpoint, { timeout: 10_000 })
    await browser.close()
    await guard.close()
    expect(methods.filter((method) => method === "session.end")).toHaveLength(3)
    expect(methods).not.toContain("browser.close")
    expect(child.exitCode).toBeNull()
  } finally {
    await browser?.close().catch(() => {})
    await guard?.close().catch(() => {})
    if (proxy) {
      for (const socket of proxy.clients) socket.terminate()
      await new Promise<void>((resolve) => proxy!.close(() => resolve()))
    }
    child.kill("SIGTERM")
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000)
    await exited
    clearTimeout(timer)
    clearTimeout(watchdog)
    await content.stop(true)
    rmSync(profile, { recursive: true, force: true })
  }
}, 45_000)
