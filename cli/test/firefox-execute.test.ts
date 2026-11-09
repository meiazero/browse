import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { defaultBidiEndpoint, parseBidiEndpoint, readRelayConfig, writeRelayConfig } from "../src/relay/config.ts"
import { Effect } from "effect"
import { OpenCodeBrowserSessions } from "../src/session-manager.ts"

describe("Firefox relay settings", () => {
  test("keeps Chromium as the default and stores the Firefox endpoint beside hostname", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "browse-bidi-config-"))
    try {
      expect(readRelayConfig(root)).toEqual({})
      expect(defaultBidiEndpoint).toBe("ws://127.0.0.1:9222/session")
      writeRelayConfig({ hostname: "127.0.0.1", browser: "firefox", bidiEndpoint: "ws://127.0.0.1:19300/session" }, root)
      expect(readRelayConfig(root)).toEqual({ hostname: "127.0.0.1", browser: "firefox", bidiEndpoint: "ws://127.0.0.1:19300/session" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("accepts WebSocket endpoints and rejects credentials and other schemes", () => {
    expect(parseBidiEndpoint("wss://example.test/session")).toBe("wss://example.test/session")
    for (const value of [undefined, 7, "bad", "http://example.test", "ws://user:secret@example.test/session"]) {
      expect(parseBidiEndpoint(value)).toBeUndefined()
    }
  })

  test("an invalid stored endpoint never falls back to a different browser endpoint", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "browse-bidi-invalid-"))
    try {
      writeFileSync(path.join(root, "config.json"), JSON.stringify({ browser: "firefox", bidiEndpoint: "bad" }))
      expect(() => readRelayConfig(root)).toThrow("bidiEndpoint")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("guard adoption authorization follows the session manager's current target", async () => {
    const sessions = new OpenCodeBrowserSessions("http://unused.invalid")
    sessions.createNew("owner")
    sessions.createNew("other")
    expect(sessions.isAdoptedContext("owner", "loaded")).toBe(false)
    await Effect.runPromise(sessions.adopt({ sessionId: "owner", createIfMissing: false, targetId: "loaded", targetUrl: "https://example.test" }))
    expect(sessions.isAdoptedContext("owner", "loaded")).toBe(true)
    expect(sessions.isAdoptedContext("other", "loaded")).toBe(false)
    expect(sessions.isAdoptedContext("owner", "unrelated")).toBe(false)
    await Effect.runPromise(sessions.reset("owner"))
    expect(sessions.isAdoptedContext("owner", "loaded")).toBe(false)
    await Effect.runPromise(sessions.closeAll())
  })
})
