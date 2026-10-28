import { expect, test } from 'bun:test'
import { matchNames, spokenInvite, splitNames, squash } from '../src/contacts.ts'

test('a spoken invite starts the sentence; a line that only mentions inviting is left alone', () => {
  expect(spokenInvite('Invite riotcoder and cha0spunk.')).toEqual(['riotcoder', 'cha0spunk'])
  expect(spokenInvite('Hey group call, invite Kim, Preshy and riot coder to the call.')).toEqual(['Kim', 'Preshy', 'riot coder'])
  expect(spokenInvite('Can you invite Chaos Punk please?')).toEqual(['Chaos Punk'])
  expect(spokenInvite('okay bring in the agents riotcoder')).toEqual(['riotcoder'])
  expect(spokenInvite('Riot coder, invite Kim.')).toEqual(['Kim'])
  // Parsed as an invite, but none of it is in a book: the call stays quiet (voiceInvite).
  expect(spokenInvite('So we went, invite only, to the party')).toEqual(['only', 'to the party'])
  expect(spokenInvite('we should invite more investors next time')).toBeNull()
  expect(spokenInvite('I got the invite yesterday')).toBeNull()
})

test('names split on commas and "and", without filler', () => {
  expect(splitNames('riotcoder, cha0spunk & Kim too')).toEqual(['riotcoder', 'cha0spunk', 'Kim'])
  expect(squash('Cha0spunk')).toBe(squash('chaos punk'))
})

test('names match the book the way speech recognition spells them, and a close call is asked about', () => {
  const book = [
    { name: 'riotcoder', aliases: ['riot coder'] },
    { name: 'cha0spunk', aliases: ['chaos punk'] },
    { name: 'Kim Lee', aliases: [] },
    { name: 'Preshy', aliases: [] },
    { name: 'Dan Smith', aliases: [] },
    { name: 'Dan Jones', aliases: [] },
  ]
  const got = matchNames(['Riot Coder', 'Chaos Punk', 'kim', 'Preshie', 'Dan', 'Zed'], book)
  expect(got.map((m) => m.contact?.name ?? (m.ambiguous ? `?${m.ambiguous.map((c) => c.name).join('|')}` : null))).toEqual(['riotcoder', 'cha0spunk', 'Kim Lee', 'Preshy', '?Dan Smith|Dan Jones', null])
})
