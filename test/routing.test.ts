import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { defaultDeck, loadRoutes, parseDeck, Router } from '../src/routing.ts'

test('a CSV rate deck: prefix,rate a line; headers skipped, a blank or - rate blocks', () => {
  expect(parseDeck('prefix,rate\n44,0.009\n+447, 0.04\n1876,-\n1900,\n')).toEqual({ '44': 0.009, '447': 0.04, '1876': null, '1900': null })
})

test('longest prefix prices a number on each route; blocked and over-cap routes drop out', () => {
  const router = new Router(
    [
      { provider: 'a', connectionId: 'ca', rates: defaultDeck(0.007) },
      { provider: 'b', connectionId: 'cb', rates: { '1': 0.005, '1876': 0.2 } },
    ],
    0.05,
  )
  expect(router.choices('+14085550101').map((c) => c.provider)).toEqual(['b', 'a'])
  expect(router.choices('+18765551234')).toEqual([]) // both over the cap
  expect(router.choices('+19005551234').map((c) => c.provider)).toEqual(['b']) // premium: blocked on the default deck
  expect(router.northAmericaOnly).toBe(false)
  expect(new Router([{ provider: 'us', connectionId: 'c', rates: { '1': 0.007 } }]).northAmericaOnly).toBe(true)
})

test('a learned rate beats the deck on its route, but never unblocks a blocked prefix', () => {
  const router = new Router([{ provider: 'a', connectionId: 'ca', rates: defaultDeck() }])
  expect(router.choices('+442079460000')[0]).toMatchObject({ prefix: '', rate: 0.25 })
  expect(router.choices('+442079460000', { a: { '442079': 0.012 } })[0]).toMatchObject({ prefix: '442079', rate: 0.012 })
  expect(router.choices('+19005551234', { a: { '19005': 0.01 } })).toEqual([])
})

test('a routes file reads its CSV deck relative to itself; inline rates win', () => {
  const dir = mkdtempSync(`${process.env.TMPDIR ?? '/tmp'}/gc-routes-`)
  writeFileSync(`${dir}/intl.csv`, '44,0.01\n33,0.012\n')
  writeFileSync(`${dir}/routes.json`, JSON.stringify({ maxRate: 0.03, routes: [{ provider: 'intl', connectionId: 'c', deck: 'intl.csv', rates: { '33': 0.011 } }] }))
  expect(loadRoutes(`${dir}/routes.json`)).toEqual({ maxRate: 0.03, routes: [{ provider: 'intl', connectionId: 'c', rates: { '44': 0.01, '33': 0.011 } }] })
})
