/**
 * The Moshpit ring bar: the thin strip across the top of every page that links
 * this site to the others on the ring (https://pit.world/ring).
 *
 * pit.world owns the member list. We read https://pit.world/api/ring every ten
 * minutes in the background and draw the bar ourselves, so a page never waits
 * on pit.world and needs no script or CSP exception; until the first read (or
 * if pit.world is down) the list below is used.
 *
 * A Moshpit name opens only for a visitor on Moshpit DNS. Everyone else reaches
 * it through pit.world's relay, https://<name>.pit.world/, which (like the
 * registry gateway) tells us so with an x-moshpit-name header. So: a request for
 * our own name without that header came from Moshpit DNS and gets direct links;
 * anything else gets relay links.
 *
 * Same file in seo.rank and family.ancestry; pit.world has the original in src/ring.ts.
 */
const RING_HOME = 'https://pit.world/ring'
const RING_API = 'https://pit.world/api/ring'
const relayUrl = (name: string) => `https://${name}.pit.world/`
export const RING_PLACEHOLDER = '<!--ring-bar-->'

export type RingSite = { name: string; about: string; moshpit: boolean }

let sites: RingSite[] = [
  { name: 'pit.world', about: 'Private search, and the front door of the Moshpit network.', moshpit: false },
  { name: 'seo.rank', about: 'Free, open-source on-page SEO audit. API, CLI and MCP.', moshpit: true },
  { name: 'family.ancestry', about: 'Your family tree, on your own name. Import GEDCOM, share by link.', moshpit: true },
]

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]!)

export function ringSites(): RingSite[] {
  return sites
}

/** Replace the member list from an /api/ring document; a malformed one is ignored. */
export function setRing(doc: unknown): boolean {
  const list = (doc as { sites?: unknown })?.sites
  if (!Array.isArray(list)) return false
  const next = list
    .filter((s) => s && typeof s.name === 'string' && /^[a-z0-9.-]{1,253}$/.test(s.name))
    .map((s) => ({ name: s.name as string, about: String(s.about ?? '').slice(0, 200), moshpit: s.moshpit === true }))
  if (!next.length) return false
  sites = next
  return true
}

/** Refresh from pit.world now and every `everyMs`. Failures keep the last good list. */
export function startRingRefresh(fetchImpl: typeof fetch = fetch, everyMs = 10 * 60_000): () => void {
  const refresh = () =>
    fetchImpl(RING_API, { signal: AbortSignal.timeout(5000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((doc) => doc && setRing(doc))
      .catch(() => {})
  refresh()
  const timer = setInterval(refresh, everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** True when the request reached us by our own Moshpit name, not through the gateway. */
export function visitorOnMoshpit(self: string, host: string | undefined, gatewayHeader: string | undefined): boolean {
  return !gatewayHeader && String(host ?? '').toLowerCase().replace(/:\d+$/, '') === self
}

export function siteHref(site: RingSite, direct: boolean): string {
  return site.moshpit && !direct ? relayUrl(site.name) : `https://${site.name}/`
}

/** The ring, the site you are on between its neighbours, random, and the way in for a builder (pit.world/start). */
export function ringBar(self: string, direct: boolean): string {
  const at = sites.findIndex((s) => s.name === self)
  const i = at < 0 ? 0 : at
  const prev = sites[(i - 1 + sites.length) % sites.length]!
  const next = sites[(i + 1) % sites.length]!
  const link = (s: RingSite, text = s.name) =>
    `<a href="${esc(siteHref(s, direct))}"${s.name === self ? ' aria-current="page"' : ''} title="${esc(s.about)}">${esc(text)}</a>`
  const current = sites.find((s) => s.name === self)
  const here = current ? link(current) : `<span aria-current="page">${esc(self)}</span>`
  return `<nav class="ring-bar" aria-label="Moshpit ring">
  <a class="ring-home" href="${RING_HOME}">◉ <span>Moshpit </span>ring</a>
  ${link(prev, `‹ ${prev.name}`)}
  <span class="ring-sites">${here}</span>
  ${link(next, `${next.name} ›`)}
  <a href="${RING_HOME}/random?from=${encodeURIComponent(self)}${direct ? '&amp;direct=1' : ''}">random</a>
  <a class="ring-start" href="https://pit.world/start">Start building here…</a>
</nav>`
}
