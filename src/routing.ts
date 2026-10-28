/**
 * Least-cost routing for calls the room places (https://en.wikipedia.org/wiki/Least-cost_routing).
 *
 * Every route is a way out to the phone network: a Telnyx call-control app tied
 * to an outbound voice profile, with its own rate deck (destination prefix to
 * USD a minute). A number is priced on each route by its longest matching
 * prefix; the cheapest route is tried first and the next cheapest only if that
 * one will not place the call. A prefix priced `null` is blocked on that route,
 * and nothing dearer than `maxRate` a minute is ever dialled. The empty prefix
 * prices everything else.
 *
 * A deck's rate is an estimate until a call proves it: Telnyx's call.cost says
 * what a minute really cost, and that learned rate (per route, per number
 * prefix) wins over the deck from then on. What a day of calls may cost in all
 * is capped separately (see GroupCallService.spentToday).
 */
import { readFileSync } from 'node:fs'

/** USD a minute by destination prefix, digits after the +; `null` blocks it. */
export type RateDeck = Record<string, number | null>

export type Route = {
  /** A name for logs and the API, like "telnyx" or "telnyx-intl". */
  provider: string
  /** Telnyx call-control app id the call goes out on. */
  connectionId: string
  /** Caller id on this route; the room's dial-in number when unset. */
  from?: string
  rates: RateDeck
}

export type RouteChoice = { provider: string; connectionId: string; from?: string; prefix: string; rate: number }

/** Telnyx's US/Canada outbound rate, near enough, for the deck nobody configured. */
export const DEFAULT_NANP_RATE = 0.007
/** Everywhere else, until a call there says what it costs: on the high side, so the day's cap errs early. */
export const DEFAULT_INTL_RATE = 0.25
/** Dearest a minute we will ever dial (satellite phones and the like are dearer), unless the routes file says otherwise. */
export const DEFAULT_MAX_RATE = 1

/**
 * +1 is not just the US and Canada: these area codes are the Caribbean, the
 * Atlantic and the Pacific, billed as international (and the home of callback
 * scams), so they are priced as international. 900 and 976 are premium lines
 * and blocked outright.
 */
export const NANP_OUTSIDE_US_CA = [
  '242', '246', '264', '268', '284', '340', '345', '441', '473', '649', '658', '664', '670', '671', '684',
  '721', '758', '767', '784', '787', '809', '829', '849', '868', '869', '876', '939',
]
export const PREMIUM_NANP = ['900', '976']

/** The deck behind a plain TELNYX_CONNECTION_ID: every country, the US and Canada at their own rate, premium lines blocked. */
export function defaultDeck(rate = DEFAULT_NANP_RATE, intl = DEFAULT_INTL_RATE): RateDeck {
  return {
    '': intl,
    '1': rate,
    ...Object.fromEntries(NANP_OUTSIDE_US_CA.map((a) => [`1${a}`, intl])),
    ...Object.fromEntries(PREMIUM_NANP.map((a) => [`1${a}`, null])),
  }
}

/** The prefix a learned rate is kept under: the number less its last six digits (country and area, roughly). */
export const learnedPrefix = (e164: string) => {
  const d = e164.replace(/\D/g, '')
  return d.slice(0, Math.max(1, d.length - 6))
}

/** A carrier rate deck as CSV, `prefix,rate` a line; a blank or `-` rate blocks the prefix. */
export function parseDeck(csv: string): RateDeck {
  const deck: RateDeck = {}
  for (const line of csv.split(/\r?\n/)) {
    const [p, r] = line.split(',').map((s) => s.trim())
    const prefix = (p ?? '').replace(/\D/g, '')
    if (!prefix) continue // headers and comments carry no digits
    if (!r || r === '-') deck[prefix] = null
    else if (Number.isFinite(Number(r))) deck[prefix] = Number(r)
  }
  return deck
}

/**
 * The routes file (GROUPCALL_ROUTES): `{ maxRate?, routes: [{ provider, connectionId, from?, rates?, deck? }] }`,
 * where `deck` is the path of a CSV rate deck, read relative to the file.
 */
export function loadRoutes(path: string): { routes: Route[]; maxRate?: number } {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { maxRate?: number; routes?: (Route & { deck?: string })[] }
  const dir = path.replace(/[^/]*$/, '')
  const routes = (raw.routes ?? []).map((r) => {
    if (!r.provider || !r.connectionId) throw new Error(`${path}: every route needs a provider and a connectionId`)
    const deck = r.deck ? parseDeck(readFileSync(r.deck.startsWith('/') ? r.deck : dir + r.deck, 'utf8')) : {}
    return { provider: r.provider, connectionId: r.connectionId, ...(r.from ? { from: r.from } : {}), rates: { ...deck, ...(r.rates ?? {}) } }
  })
  return { routes, ...(typeof raw.maxRate === 'number' ? { maxRate: raw.maxRate } : {}) }
}

export class Router {
  readonly maxRate: number

  constructor(
    readonly routes: Route[],
    maxRate = DEFAULT_MAX_RATE,
  ) {
    this.maxRate = maxRate
  }

  /**
   * Every route that will carry `e164` within the cap, cheapest first; equal rates keep the file's order.
   * `learned` (provider -> prefix -> rate) is what calls really cost; a learned rate beats the deck,
   * but never unblocks a prefix the deck blocks.
   */
  choices(e164: string, learned: Record<string, Record<string, number>> = {}): RouteChoice[] {
    const digits = e164.replace(/\D/g, '')
    const out: RouteChoice[] = []
    for (const route of this.routes) {
      const prefix = longestPrefix(route.rates, digits)
      if (prefix === null || route.rates[prefix] === null) continue
      const known = learned[route.provider] ?? {}
      const proved = longestPrefix(known, digits)
      const rate = proved !== null ? known[proved] : route.rates[prefix]
      if (rate === null || rate === undefined || rate > this.maxRate) continue
      out.push({ provider: route.provider, connectionId: route.connectionId, ...(route.from ? { from: route.from } : {}), prefix: proved ?? prefix, rate })
    }
    return out.sort((a, b) => a.rate - b.rate)
  }

  /** Only North America is reachable: the error can say "US or Canadian". */
  get northAmericaOnly(): boolean {
    return this.routes.every((r) => Object.entries(r.rates).every(([p, rate]) => rate === null || p.startsWith('1')))
  }
}

function longestPrefix(deck: Record<string, unknown>, digits: string): string | null {
  for (let n = digits.length; n >= 0; n--) {
    const p = digits.slice(0, n)
    if (p in deck) return p
  }
  return null
}
