/**
 * The Profullstack webring footer (@profullstack/footer): our links, the copyright
 * and << Profullstack >>. It must be in the server-rendered HTML: rssamplifier's
 * ring verifier reads the page and never runs script, so a client-side footer never
 * counts. (The Moshpit ring bar at the top and the pit.world footer are separate.)
 *
 * Starts from the template bundled with the package, then re-reads the @latest
 * template in the background every 15 minutes, so a page never waits on the CDN and
 * a footer release reaches us without a redeploy. A failed read keeps the last copy.
 */
import { descriptor, footerHtml, footerHtmlSync, type FooterOptions } from '@profullstack/footer'

/** The ring member URL (the web2 hostname; hops are measured from it). */
export const RING_SITE = 'https://ad.network.pit.world/'

const OPTIONS: FooterOptions = {
  site: RING_SITE,
  name: 'ad.network',
  links: [
    { label: 'Help', href: '/help' },
    { label: 'API, CLI, MCP', href: '/help#agents' },
    { label: 'Source', href: 'https://github.com/moshcoder/ad.network' },
    { label: 'Ads by crawlproof', href: 'https://crawlproof.com' },
    { label: 'Payments by CoinPay', href: 'https://coinpayportal.com' },
  ],
}

let cached = footerHtmlSync(OPTIONS)

/** The footer HTML to print in the layout. */
export const ringFooter = (): string => cached

/** /.well-known/openwebring.json */
export const ringDescriptor = () => descriptor({ site: RING_SITE, name: 'ad.network' })

export function startRingFooterRefresh(everyMs = 15 * 60_000): () => void {
  const refresh = () =>
    footerHtml(OPTIONS)
      .then((html) => {
        if (typeof html === 'string' && html.includes('ring/profullstack')) cached = html
      })
      .catch(() => {})
  refresh()
  const timer = setInterval(refresh, everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
