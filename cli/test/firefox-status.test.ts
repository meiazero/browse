import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { WebSocketServer } from "ws"
import { startRelay, stopRelay } from "./relay-harness.ts"

const run = promisify(execFile)

test("doctor and status expose guarded BiDi diagnostics in JSON and text without requiring a Chromium extension", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "browse-firefox-status-"))
  const remote = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await new Promise<void>((resolve) => remote.once("listening", resolve))
  const endpoint = `ws://127.0.0.1:${(remote.address() as AddressInfo).port}/session`
  let ready = true
  let malformed = false
  const commands: string[] = []
  remote.on("connection", (socket) => socket.on("message", (data) => {
    const command = JSON.parse(String(data))
    commands.push(command.method)
    socket.send(JSON.stringify({ type: "success", id: command.id, result: malformed ? { ready: "private-data" } : { ready, message: "" } }))
  }))
  writeFileSync(path.join(root, "config.json"), JSON.stringify({ browser: "firefox", bidiEndpoint: endpoint }))
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined
  try {
    relay = await startRelay(root)
    const cli = async (args: string[], expectedExit = 0) => {
      let result: { stdout: string; stderr: string }
      let exitCode = 0
      try {
        result = await run(process.execPath, [path.join(import.meta.dir, "../src/main.ts"), ...args], {
          env: { ...process.env, OPENCODE_BROWSER_HOME: root, OPENCODE_BROWSER_PORT: String(relay!.port), OPENCODE_BROWSER_UPDATE_CHECK: "0" },
          timeout: 10_000,
        })
      } catch (error) {
        const failed = error as Error & { stdout: string; stderr: string; code: number }
        if (failed.code !== 1) throw error
        exitCode = failed.code
        result = { stdout: failed.stdout, stderr: failed.stderr }
      }
      expect(exitCode, result.stderr).toBe(expectedExit)
      return result
    }
    const headers = { authorization: `Bearer ${relay.token}` }
    const denied = await fetch(`http://127.0.0.1:${relay.port}/extension/status`)
    expect(denied.status).toBe(401)
    expect(commands).toEqual([])
    const status = JSON.parse((await cli(["status", "--json"])).stdout)
    expect(status.bidi).toEqual({ endpoint, reachable: true, sessionSlot: "free", error: null })
    expect((await cli(["status"])).stdout).toContain(`BiDi: ${endpoint} (reachable); session slot: free`)
    const doctor = JSON.parse((await cli(["doctor", "--json"])).stdout)
    expect(doctor.bidi).toEqual(status.bidi)
    expect(doctor.status).not.toBe("fail")
    expect(doctor.checks.filter((check: { id: string }) => check.id.startsWith("extension-"))).toEqual([])
    expect(doctor.checks.find((check: { id: string }) => check.id === "bidi-session-slot").status).toBe("ok")
    expect(doctor.recommendations.join(" ")).not.toContain("Chrome Web Store")
    expect((await cli(["doctor"])).stdout).toContain("session slot: free")
    ready = false
    expect((await cli(["status"])).stdout).toContain("session slot: occupied by another client")
    const occupied = JSON.parse((await cli(["doctor", "--json"])).stdout)
    expect(occupied.bidi.sessionSlot).toBe("occupied")
    expect(occupied.status).toBe("warn")
    expect(occupied.recommendations.join(" ")).toContain("session.end")
    malformed = true
    const invalid = JSON.parse((await cli(["doctor", "--json"], 1)).stdout)
    expect(invalid.status).toBe("fail")
    expect(invalid.bidi).toMatchObject({ reachable: false, sessionSlot: "unknown" })
    expect(JSON.stringify(invalid)).not.toContain("private-data")
    expect(commands.length).toBeGreaterThan(0)
    expect(commands.every((method) => method === "session.status")).toBe(true)
    const response = await fetch(`http://127.0.0.1:${relay.port}/extension/status`, { headers })
    expect((await response.json() as { transport: string }).transport).toBe("bidi")
    for (const socket of remote.clients) socket.terminate()
    await new Promise<void>((resolve) => remote.close(() => resolve()))
    const offline = JSON.parse((await cli(["status", "--json"])).stdout)
    expect(offline.bidi).toMatchObject({ endpoint, reachable: false, sessionSlot: "unknown" })
    expect(offline.bidi.error).toContain("--remote-debugging-port")
  } finally {
    await stopRelay(relay?.child)
    for (const socket of remote.clients) socket.terminate()
    await new Promise<void>((resolve) => remote.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
