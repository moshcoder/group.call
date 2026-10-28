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
  expect(router.choices('+18765551234')).toEqual([]) // blocked on a, over the cap on b
  expect(router.northAmericaOnly).toBe(true)
})

test('a routes file reads its CSV deck relative to itself; inline rates win', () => {
  const dir = mkdtempSync(`${process.env.TMPDIR ?? '/tmp'}/gc-routes-`)
  writeFileSync(`${dir}/intl.csv`, '44,0.01\n33,0.012\n')
  writeFileSync(`${dir}/routes.json`, JSON.stringify({ maxRate: 0.03, routes: [{ provider: 'intl', connectionId: 'c', deck: 'intl.csv', rates: { '33': 0.011 } }] }))
  expect(loadRoutes(`${dir}/routes.json`)).toEqual({ maxRate: 0.03, routes: [{ provider: 'intl', connectionId: 'c', rates: { '44': 0.01, '33': 0.011 } }] })
})
