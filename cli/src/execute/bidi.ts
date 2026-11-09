import type { Page } from "patchright-core"

// Patchright's in-process bridge exposes the BiDi context without a CDP round trip.
export function bidiPageIdentity(page: Page): { id: string; owned: boolean } | undefined {
  if (page.context().browser?.()?.browserType().name() !== "firefox") return undefined
  const client = page as Page & { _connection: { toImpl: (page: Page) => {
    delegate: { _session: { sessionId: string }; _browserContext: { _browser: { _connection: { _ownedBrowsingContexts: Set<string> } } } }
  } } }
  const delegate = client._connection.toImpl(page).delegate
  const id = delegate._session.sessionId
  return { id, owned: delegate._browserContext._browser._connection._ownedBrowsingContexts.has(id) }
}
