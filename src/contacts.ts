/**
 * The contacts book: who a room's owner can invite by name, people and agents.
 *
 * Said on the line ("invite riotcoder and Preshy"), typed on the room page or sent
 * to the API, names are matched here. Speech recognition spells names its own way
 * ("Chaos Punk", "riot coder"), so a name is compared squashed (letters only, the
 * leetspeak digits read as letters) and close is good enough when nothing else is
 * as close.
 */

/**
 * How a contact is reached. A person is rung and presses 1. An agent is one of ours
 * (the worker dials it in), a SIP voice agent, or an agent on a phone number, rung
 * straight in with no press 1.
 */
export type Contact = {
  id: string
  sub: string
  name: string
  kind: 'person' | 'agent'
  phone: string
  sip: string
  /** One of our own agents (AGENTS), dialled in by the worker. */
  agent: string
  email: string
  aliases: string[]
  note: string
  /** A person whose phone may ask for invites by voice, the way a known caller can. */
  trusted: boolean
  createdAt: number
  updatedAt: number
}

/** "Cha0spunk" and "chaos punk" both become "chaospunk". */
export function squash(name: string): string {
  const leet: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't' }
  return name
    .toLowerCase()
    .replace(/[013457]/g, (d) => leet[d]!)
    .replace(/[^a-z]/g, '')
}

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = up
    }
  }
  return prev[b.length]!
}

/** Roughly how a squashed name sounds: "Preshie" and "Preshy", "Steph" and "Stef" agree. */
const sound = (s: string) => s.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/(ie|ey|ee|i)$/, 'y').replace(/(.)\1+/g, '$1')

/** How alike a heard name is to a contact's, 0 to 1. A first or last name alone counts nearly in full. */
export function likeness(heard: string, name: string): number {
  const h = squash(heard)
  const n = squash(name)
  if (!h || !n) return 0
  if (h === n) return 1
  const words = name.split(/\s+/).map(squash).filter(Boolean)
  if (words.length > 1 && words.includes(h)) return 0.95
  const close = (a: string, b: string) => 1 - distance(a, b) / Math.max(a.length, b.length)
  return Math.max(close(h, n), sound(h) === sound(n) ? 0.9 : close(sound(h), sound(n)))
}

/** A name close enough to count, when nothing else is as close. */
export const LIKE_ENOUGH = 0.75

export type Match<T> = { heard: string; contact: T | null; ambiguous?: T[] }

/** Find each heard name in the book: the closest contact, or none, or the ones too close to call. */
export function matchNames<T extends { name: string; aliases: string[] }>(heard: string[], book: T[]): Match<T>[] {
  return heard.map((h) => {
    const scored = book
      .map((c) => ({ c, score: Math.max(likeness(h, c.name), ...c.aliases.map((a) => likeness(h, a))) }))
      .filter((x) => x.score >= LIKE_ENOUGH)
      .sort((a, b) => b.score - a.score)
    if (!scored.length) return { heard: h, contact: null }
    const best = scored[0]!
    const tied = scored.filter((x) => x.c !== best.c && best.score - x.score < 0.05 && best.score < 1)
    return tied.length ? { heard: h, contact: null, ambiguous: [best.c, ...tied.map((x) => x.c)] } : { heard: h, contact: best.c }
  })
}

/** "riotcoder, Preshy and Kim" -> ["riotcoder", "Preshy", "Kim"]. */
export function splitNames(list: string): string[] {
  return list
    .split(/\s*(?:,|;|&|\+|\band\b|\bplus\b|\balso\b)\s*/i)
    .map((n) =>
      n
        .replace(/[.!?]+$/, '')
        .replace(/^(?:(?:the|our|my|agent|agents)\s+)+/i, '')
        .replace(/\s+(?:in|on|too|as well|please|now|here|over)$/i, '')
        .replace(/\s+(?:to|into|onto)\s+(?:the|this|our)\s+(?:call|room|line)$/i, '')
        .replace(/[.!?]+$/, '')
        .trim(),
    )
    .filter((n) => n.length > 1 && n.length <= 40)
}

/**
 * The names in a spoken invite, or null when the line is not one. It has to start
 * the sentence ("Invite riotcoder", "Hey group call, invite Kim", "Can you invite
 * Preshy and riotcoder?") so a line that only mentions inviting is left alone.
 */
export function spokenInvite(text: string): string[] | null {
  const t = text.replace(/\s+/g, ' ').trim()
  // An addressee first is fine too: "riotcoder, invite Kim".
  const m = /^(?:(?:hey|ok(?:ay)?|so|um+|uh+|alright|all right|right)[,.]?\s+)*(?:[\w']+(?: [\w']+)?,\s+)?(?:(?:can|could|would) you\s+|please\s+|go ahead and\s+|let'?s\s+)*(?:invite|bring in|call in|dial in)\s+(.+)$/i.exec(t)
  if (!m) return null
  const names = splitNames(m[1]!.replace(/\s+(?:in|into|to)\s+(?:the|this|our)\s+(?:call|room|line)[.!?]*$/i, ''))
  return names.length ? names : null
}
