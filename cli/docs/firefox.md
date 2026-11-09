# Firefox and Zen execution

Configure the relay before starting it:

```sh
browse set browser firefox
browse set bidiEndpoint ws://127.0.0.1:19399/session
```

The default browser is Chromium. Firefox's default endpoint is `ws://127.0.0.1:9222/session`; configuring an endpoint does not launch or probe a browser. `browse set` restarts a managed relay when it can. Stop and restart a foreground `browse serve` yourself.

## Start Firefox or Zen

Save your tabs and quit the browser yourself before changing its launcher. Passing a flag to an already running instance does not enable its Remote Agent. Start the browser with one of these commands:

```sh
firefox --remote-debugging-port=9222
zen --remote-debugging-port=9222
# Flatpak Zen:
flatpak run app.zen_browser.zen --remote-debugging-port=9222
```

Match the port in browse's existing setting:

```sh
browse set browser firefox
browse set bidiEndpoint ws://127.0.0.1:9222/session
```

Undo: quit the browser yourself and launch it without `--remote-debugging-port`. To restore browse's defaults, run `browse set browser chromium` and `browse set bidiEndpoint ws://127.0.0.1:9222/session`.

### Permanent Linux desktop entry override

Copy the shipped desktop entry into your user applications directory under the same filename. Do not edit the system copy. For a system Firefox install with `/usr/share/applications/firefox.desktop`:

```sh
mkdir -p "$HOME/.local/share/applications"
test ! -e "$HOME/.local/share/applications/firefox.desktop" &&
  cp /usr/share/applications/firefox.desktop "$HOME/.local/share/applications/firefox.desktop"
```

If that destination already exists, back it up before editing: `cp "$HOME/.local/share/applications/firefox.desktop" "$HOME/.local/share/applications/firefox.desktop.before-bidi"`. Preserve this backup until you undo the change. If your distribution uses a different desktop filename, use that filename for both copies.

Edit the copied file's `Exec=` lines to add `--remote-debugging-port=9222` after the Firefox executable, preserving existing arguments and field codes. For example:

```ini
Exec=firefox --remote-debugging-port=9222 %u
```

Undo a newly created override: `rm "$HOME/.local/share/applications/firefox.desktop"`. Undo an edited existing override: `mv "$HOME/.local/share/applications/firefox.desktop.before-bidi" "$HOME/.local/share/applications/firefox.desktop"`. Quit and restart Firefox yourself afterward.

For Flatpak Zen, copy its exported entry instead; this works for system and per-user Flatpak installs:

```sh
mkdir -p "$HOME/.local/share/applications"
test ! -e "$HOME/.local/share/applications/app.zen_browser.zen.desktop" &&
  cp "$(flatpak info --show-location app.zen_browser.zen)/export/share/applications/app.zen_browser.zen.desktop" "$HOME/.local/share/applications/app.zen_browser.zen.desktop"
```

If that destination already exists, first run `cp "$HOME/.local/share/applications/app.zen_browser.zen.desktop" "$HOME/.local/share/applications/app.zen_browser.zen.desktop.before-bidi"`. In each copied `Exec=` line, insert `--remote-debugging-port=9222` after `app.zen_browser.zen`, before any file-forwarding arguments such as `@@u %U @@`. Keep Flatpak's existing options intact. The simpler terminal equivalent is `flatpak run app.zen_browser.zen --remote-debugging-port=9222`.

Undo a newly created override: `rm "$HOME/.local/share/applications/app.zen_browser.zen.desktop"`. Undo an edited existing override: `mv "$HOME/.local/share/applications/app.zen_browser.zen.desktop.before-bidi" "$HOME/.local/share/applications/app.zen_browser.zen.desktop"`. Quit and restart Zen yourself afterward. User overrides shadow future launcher updates; remove or refresh them when the shipped entry changes.

## Local endpoint security

While the debugging port is open, **any local process can control the browser and read its tabs, cookies and logged-in sessions without pairing**. The browser endpoint has no browse relay token. Keep it bound to `127.0.0.1` only; stock Firefox's Remote Agent restricts connections to loopback and uses the local listener by default. Confirm the startup message names `127.0.0.1`, and never expose the port through forwarding, proxies or permissive host/origin overrides. See [Mozilla's Remote Agent security documentation](https://firefox-source-docs.mozilla.org/remote/Security.html).

Browse should hold the single BiDi session as soon as the browser starts. Immediately after each launch, run:

```sh
browse execute --session firefox-main 'return page.url()'
```

This starts the relay if needed, creates or reconnects `firefox-main`, reserves the slot and creates a browse-owned tab if needed. Reuse `firefox-main` for execution; only one browse session can attach at a time. Undo: `browse session delete firefox-main` releases the slot and closes its browse-created tabs. This reservation reduces the opportunity for another client to attach; it does not authenticate the browser endpoint. The relay alone does not reserve a session at startup, and diagnostics never reserve it.

## Diagnostics

With the relay running, use `browse status` or `browse doctor`; both accept `--json`. They query the configured endpoint through the relay guard using only `session.status`. They never create/end a session or touch tabs. A stopped relay is reported as stopped; neither command starts it or probes the browser in that case. Use `browse serve` to start a foreground relay, with Ctrl+C as its undo.

The JSON `bidi` object contains `endpoint`, `reachable`, `sessionSlot` and `error`. `sessionSlot` is `free`, `browse` (reserved by this relay), `occupied` (another client), or `unknown` (unavailable or invalid response). A free slot or browse's own reservation is healthy. An external occupant produces a doctor warning; an unavailable endpoint fails the endpoint check. Firefox mode does not require the Chromium extension.

If the endpoint is unavailable, check the startup flag and port, then restart the browser yourself if needed. If another client occupies the slot, stop that client normally so it sends `session.end`. If the slot remains occupied after an unclean disconnect, save your browser session and restart Firefox/Zen yourself. Do not try to end an unfamiliar session. These checks are a snapshot; another process can acquire a free slot afterward.

## Execution and ownership

All Firefox connections go through the authenticated relay's `/bidi` guard. The guard drops `browser.close`, checks tab ownership, and ends the BiDi session on disconnect. Playwright also refuses to close an existing user tab, including an adopted one. Session deletion closes only tabs created by that connection.

One browse session can hold the Firefox connection at a time. Delete or reset it before connecting another session. Only loaded tabs are available for adoption; tab ids shown by this relay are temporary inventory ids, not extension tab ids. Browser-session context ids are not saved across relay restarts.

CDP calls, including `newCDPSession`, `pageConsole.start()` and cursor helpers, fail with a Chromium requirement. Handoff requires the future Firefox extension. Read-only sessions and domain allowlists are rejected because their enforcement currently depends on CDP. A normal Playwright script can navigate, query locators, click, evaluate JavaScript and return results.

## Isolated verification

```sh
cd cli
BROWSE_TEST_FIREFOX_BIDI=1 bun test test/firefox-execute.test.ts test/firefox-execute.integration.test.ts
```

The integration test starts `/usr/bin/firefox` with a new temporary profile and a free port in 19300–19399. It runs the real MCP server, checks execution and adoption, reconnects, and verifies that the pre-existing tab survives. It terminates only the Firefox process it started and removes its temporary files.

Diagnostics also have browser-free checks: `cd cli && bun test test/bidi-guard.test.ts test/firefox-status.test.ts`. They cover free/occupied slots, browse's reservation, unavailable or malformed endpoints, timeouts, and both CLI output formats.

## Manual Zen validation

1. Save your browser session. Restart Zen yourself with `--remote-debugging-port=19399` added to its normal launcher. Confirm that this is the browser you intend to control.
2. Run the two configuration commands at the top of this document (port 19399). Start `browse serve` in a terminal if you use a foreground relay. Run `browse status` and `browse doctor --json`: expect a reachable BiDi endpoint, a `free` slot and no Chromium extension requirement.
3. In your MCP client, call `session_new` with `{"id":"zen-smoke"}`, then `execute` with `{"session":"zen-smoke","code":"await page.goto('https://example.com'); return { title: await page.title(), url: page.url() }"}`. Expect a new tab in the existing window and an `Example Domain` title. Run `browse status --json`; expect `bidi.sessionSlot` to be `browse`.
4. Open a disposable tab yourself, navigate it to `https://example.org`, and leave it loaded. Call `session_adopt` with `{"session":"zen-smoke","targetUrl":"example.org"}` and `execute` with `{"session":"zen-smoke","code":"return await page.title()"}`.
5. Call `session_delete` with `{"session":"zen-smoke"}`. Confirm that Zen and the adopted tab remain open, and `browse doctor --json` reports a `free` slot again. Restore Chromium mode with `browse set browser chromium`; restore the endpoint with `browse set bidiEndpoint ws://127.0.0.1:9222/session`, then restart Zen yourself without the debugging flag.
