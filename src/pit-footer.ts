/**
 * The pit.world global footer: one line (site · Search · Ring · Publish here)
 * that pit.world serves as an HTML fragment for every site on the network.
 *
 * We read https://pit.world/snippets/footer.html?site=<name> in the background
 * (3 s timeout, again every hour) and print the last good copy as the last thing
 * in <body>, so a page never waits on pit.world. Until the first read, or if
 * pit.world is down, it renders nothing. The fragment carries data-pit-footer,
 * which tells the pit.world relay not to add a second copy.
 */
const SNIPPET = 'https://pit.world/snippets/footer.html'

let cached = ''

/** The last good footer fragment, or '' before the first read. */
export function pitFooter(): string {
  return cached
}

/** Accept a fragment only if it looks like the footer; anything else is ignored. */
export function setPitFooter(html: unknown): boolean {
  if (typeof html !== 'string' || !html.includes('data-pit-footer') || html.length > 64_000) return false
  cached = html.trim()
  return true
}

/** Refresh from pit.world now and every `everyMs`. Failures keep the last good copy. */
export function startPitFooterRefresh(site: string, fetchImpl: typeof fetch = fetch, everyMs = 60 * 60_000): () => void {
  const url = `${SNIPPET}?site=${encodeURIComponent(site)}`
  const refresh = () =>
    fetchImpl(url, { signal: AbortSignal.timeout(3000) })
      .then((r) => (r.ok ? r.text() : null))
      .then((html) => html && setPitFooter(html))
      .catch(() => {})
  refresh()
  const timer = setInterval(refresh, everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
