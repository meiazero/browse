# Firefox and Zen execution

Configure the relay before starting it:

```sh
browse set browser firefox
browse set bidiEndpoint ws://127.0.0.1:19399/session
```

The default browser is Chromium. Firefox's default endpoint is `ws://127.0.0.1:9222/session`; configuring an endpoint does not launch or probe a browser. `browse set` restarts a managed relay when it can. Stop and restart a foreground `browse serve` yourself.

All Firefox connections go through the authenticated relay's `/bidi` guard. The guard drops `browser.close`, checks tab ownership, and ends the BiDi session on disconnect. Playwright also refuses to close an existing user tab, including an adopted one. Session deletion closes only tabs created by that connection.

One browse session can hold the Firefox connection at a time. Delete or reset it before connecting another session. Only loaded tabs are available for adoption; tab ids shown by this relay are temporary inventory ids, not extension tab ids. Browser-session context ids are not saved across relay restarts.

CDP calls, including `newCDPSession`, `pageConsole.start()` and cursor helpers, fail with a Chromium requirement. Handoff requires the future Firefox extension. Read-only sessions and domain allowlists are rejected because their enforcement currently depends on CDP. A normal Playwright script can navigate, query locators, click, evaluate JavaScript and return results.

## Isolated verification

```sh
cd cli
BROWSE_TEST_FIREFOX_BIDI=1 bun test test/firefox-execute.test.ts test/firefox-execute.integration.test.ts
```

The integration test starts `/usr/bin/firefox` with a new temporary profile and a free port in 19300–19399. It runs the real MCP server, checks execution and adoption, reconnects, and verifies that the pre-existing tab survives. It terminates only the Firefox process it started and removes its temporary files.

## Manual Zen validation

1. Save your browser session. Restart Zen yourself with `--remote-debugging-port=19399` added to its normal launcher. Confirm that this is the browser you intend to control.
2. Run the two configuration commands above. Start `browse serve` in a terminal if you use a foreground relay.
3. In your MCP client, call `session_new` with `{"id":"zen-smoke"}`, then `execute` with `{"session":"zen-smoke","code":"await page.goto('https://example.com'); return { title: await page.title(), url: page.url() }"}`. Expect a new tab in the existing window and an `Example Domain` title.
4. Open a disposable tab yourself, navigate it to `https://example.org`, and leave it loaded. Call `session_adopt` with `{"session":"zen-smoke","targetUrl":"example.org"}` and `execute` with `{"session":"zen-smoke","code":"return await page.title()"}`.
5. Call `session_delete` with `{"session":"zen-smoke"}`. Confirm that Zen and the adopted tab remain open. Restore Chromium mode with `browse set browser chromium`; restore the endpoint with `browse set bidiEndpoint ws://127.0.0.1:9222/session`, then restart Zen yourself without the debugging flag.
