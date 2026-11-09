import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { firefox as firefoxApi } from "patchright-core"
import { WebSocketServer } from "ws"
import { createBidiGuard } from "../src/relay/bidi-guard.ts"
import { connectCdp, startRelay, stopRelay } from "./relay-harness.ts"
import { mcpStdio } from "./support/mcp-stdio.ts"

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

test.skipIf(process.env.BROWSE_TEST_FIREFOX_BIDI !== "1")("MCP execute creates, adopts and preserves isolated Firefox tabs through the relay", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "browse-firefox-execute-"))
  const profile = mkdtempSync(path.join(os.tmpdir(), "browse-firefox-profile-"))
  const port = await freeFirefoxPort()
  const firefox = spawn("/usr/bin/firefox", ["--headless", "--profile", profile, `--remote-debugging-port=${port}`, "--no-remote"], { stdio: ["ignore", "pipe", "pipe"] })
  const exited = new Promise<void>((resolve) => firefox.once("close", () => resolve()))
  const watchdog = setTimeout(() => firefox.kill("SIGKILL"), 55_000)
  const content = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: () => new Response('<title>Firefox execute</title><button onclick="this.textContent=\'Clicked\'">Click me</button>', { headers: { "content-type": "text/html" } }),
  })
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined
  let mcp: ReturnType<typeof mcpStdio> | undefined
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Isolated Firefox did not announce its BiDi endpoint")), 15_000)
      let output = ""
      const read = (data: Buffer) => {
        output += String(data)
        const match = output.match(/WebDriver BiDi listening on (ws:\/\/\S+)/)
        if (!match) return
        const url = new URL(match[1]!)
        clearTimeout(timer)
        if (url.port !== String(port) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
          reject(new Error("Unexpected isolated Firefox endpoint"))
          return
        }
        url.pathname = "/session"
        resolve(url.href)
      }
      firefox.stderr.on("data", read)
      firefox.stdout.on("data", read)
      firefox.once("error", (error) => { clearTimeout(timer); reject(error) })
      firefox.once("exit", () => { clearTimeout(timer); reject(new Error(`Isolated Firefox exited: ${output}`)) })
    })
    const seedGuard = createBidiGuard({ endpoint, log: () => {} })
    const seedProxy = new WebSocketServer({ host: "127.0.0.1", port: 0 })
    seedProxy.on("connection", (socket) => seedGuard.accept(socket))
    await new Promise<void>((resolve) => seedProxy.once("listening", resolve))
    try {
      const seed = await firefoxApi.connectOverBiDi(`ws://127.0.0.1:${(seedProxy.address() as net.AddressInfo).port}/session`, { timeout: 10_000 })
      try {
        await seed.contexts()[0]!.pages()[0]!.goto(new URL("/preserved", content.url).href)
      } finally {
        await seed.close()
      }
    } finally {
      await seedGuard.close()
      for (const socket of seedProxy.clients) socket.terminate()
      await new Promise<void>((resolve) => seedProxy.close(() => resolve()))
    }
    writeFileSync(path.join(root, "config.json"), JSON.stringify({ browser: "firefox", bidiEndpoint: endpoint }))
    relay = await startRelay(root)
    const headers = { authorization: `Bearer ${relay.token}`, "content-type": "application/json" }
    const post = async (route: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${relay!.port}${route}`, { method: "POST", headers, body: JSON.stringify(body) })
      const result = await response.json() as Record<string, unknown>
      expect(response.ok, JSON.stringify(result)).toBe(true)
      return result
    }
    expect(await connectCdp(`ws://127.0.0.1:${relay.port}/bidi`)).toBe(401)
    expect(await connectCdp(`ws://127.0.0.1:${relay.port}/bidi`, headers)).toBe(403)
    expect(await connectCdp(`ws://127.0.0.1:${relay.port}/devtools/browser/test`, headers)).toBe(403)
    mcp = mcpStdio({ home: root, port: relay.port })
    await mcp.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "firefox-test", version: "0" } })
    mcp.notify("notifications/initialized")
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const reply = await mcp!.request("tools/call", { name, arguments: args })
      expect(reply.result?.isError, JSON.stringify(reply)).toBe(false)
      return reply.result?.structuredContent as Record<string, unknown>
    }
    await tool("session_new", { id: "firefox-smoke" })
    const created = await fetch(`http://127.0.0.1:${relay.port}/json/list`, { headers }).then((response) => response.json()) as unknown[]
    expect(created).toHaveLength(2)
    for (const [body, message] of [
      [{ id: "firefox-busy" }, "already has an attached client"],
      [{ id: "firefox-read-only", readOnly: true }, "require Chromium"],
      [{ id: "firefox-allowlist", allowedOrigins: ["example.test"] }, "require Chromium"],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${relay.port}/cli/session/new`, { method: "POST", headers, body: JSON.stringify(body) })
      expect(response.ok).toBe(false)
      const error = await response.text()
      expect(error).toContain(message)
      expect(error).not.toContain(relay.token)
    }
    const result = await tool("execute", { session: "firefox-smoke", code: `await page.goto(${JSON.stringify(content.url.href)}); await page.getByRole('button', { name: 'Click me' }).click(); state.count = 1; return { title: await page.title(), button: await page.getByRole('button').innerText() }` })
    expect(result.value).toEqual({ title: "Firefox execute", button: "Clicked" })
    expect((await tool("execute", { session: "firefox-smoke", code: "return ++state.count" })).value).toBe(2)
    expect((await tool("execute", { session: "firefox-smoke", code: `const extra = await context.newPage(); await extra.goto(${JSON.stringify(new URL("/extra", content.url).href)}); return context.pages().length` })).value).toBe(3)
    const cdp = await mcp.request("tools/call", { name: "execute", arguments: { session: "firefox-smoke", code: "await context.newCDPSession(page)" } })
    expect(cdp.result?.isError, JSON.stringify(cdp)).toBe(true)
    expect(JSON.stringify(cdp)).toContain("CDP session is only available in Chromium")
    const consoleResult = await mcp.request("tools/call", { name: "execute", arguments: { session: "firefox-smoke", code: "await pageConsole.start()" } })
    expect(consoleResult.result?.isError).toBe(true)
    expect(JSON.stringify(consoleResult)).toContain("CDP session is only available in Chromium")
    await tool("session_adopt", { session: "firefox-smoke", targetUrl: "/preserved" })
    const adopted = await tool("execute", { session: "firefox-smoke", code: `await page.goto(${JSON.stringify(new URL("/preserved", content.url).href)}); return await page.title()` })
    expect(adopted.value).toBe("Firefox execute")
    const close = await mcp.request("tools/call", { name: "execute", arguments: { session: "firefox-smoke", code: "await page.close()" } })
    expect(close.result?.isError).toBe(true)
    expect(JSON.stringify(close)).toContain("did not create")
    const catalog = readFileSync(path.join(root, "relays", String(relay.port), "sessions.json"), "utf8")
    expect(catalog).toContain("firefox-smoke")
    expect(catalog).not.toContain('"target"')
    await tool("session_delete", { session: "firefox-smoke" })
    expect(firefox.exitCode).toBeNull()
    await tool("session_new", { id: "firefox-reconnect" })
    const preserved = await tool("execute", { session: "firefox-reconnect", code: "return context.pages().map(tab => tab.url())" })
    expect(preserved.value).toContain(new URL("/preserved", content.url).href)
    expect(preserved.value).toHaveLength(2)
    await tool("session_delete", { session: "firefox-reconnect" })
    // A fresh session can adopt immediately, before any execute or tab-creation call.
    const fresh = await post("/cli/session/adopt", { sessionId: "firefox-adopt", createIfMissing: true, targetSelection: { urlIncludes: "/preserved" } })
    expect(fresh.session).toMatchObject({ id: "firefox-adopt", created: true })
    const relayPort = relay.port
    await stopRelay(relay.child)
    relay = await startRelay(root, {}, relayPort)
    await post("/cli/session/adopt", { sessionId: "firefox-adopt", createIfMissing: false, targetSelection: { urlIncludes: "/preserved" } })
    await post("/cli/session/delete", { id: "firefox-adopt" })
    expect(firefox.exitCode).toBeNull()
  } finally {
    mcp?.close()
    await stopRelay(relay?.child)
    firefox.kill("SIGTERM")
    const timer = setTimeout(() => firefox.kill("SIGKILL"), 2_000)
    await exited
    clearTimeout(timer)
    clearTimeout(watchdog)
    await content.stop(true)
    rmSync(profile, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
