import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { main } from '../src/cli.ts'
import { GroupCallClient, type ApiContact } from '../src/client.ts'
import { createMcpServer } from '../src/mcp.ts'

function fixture(extra: ApiContact[] = []) {
  const saved: ApiContact = { id: 'saved', name: 'Kim Lee', kind: 'person', phone: '+14085550101', sip: '', agent: '', email: 'kim@example.com', aliases: ['Kim'], note: 'keep me', trusted: true }
  const requests: { method: string; path: string; body: any }[] = []
  const book = [saved, ...extra]
  const client = new GroupCallClient('https://test', 'gc_test', (async (url: string, init: RequestInit) => {
    const method = init.method!, path = new URL(url).pathname, body = init.body ? JSON.parse(String(init.body)) : null
    requests.push({ method, path, body })
    if (method === 'GET') return Response.json({ contacts: book })
    if (method === 'PATCH') return Response.json(Object.assign(saved, body))
    if (method === 'POST') return Response.json({ ...saved, ...body })
    return Response.json({ ok: true })
  }) as typeof fetch)
  const output: string[] = [], errors: string[] = []
  const run = (args: string[]) => main(args, { log: (s) => output.push(s), error: (s) => errors.push(s) }, client)
  return { client, requests, run, output, errors, saved }
}

test('CLI updates by name, preserves omitted fields, and can clear metadata and revoke trust', async () => {
  const f = fixture()
  expect(await f.run(['contact', 'update', 'Kim Lee', '--name', 'Kim Smith', '--email=', '--alias=', '--untrusted', '--json'])).toBe(0)
  expect(f.requests.at(-1)).toEqual({ method: 'PATCH', path: '/api/v1/contacts/saved', body: { name: 'Kim Smith', email: '', aliases: [], trusted: false } })
  expect(JSON.parse(f.output[0]!)).toMatchObject({ name: 'Kim Smith', phone: '+14085550101', note: 'keep me', trusted: false })
  expect(await f.run(['contact', 'show', 'saved', '--json'])).toBe(0)
  expect(JSON.parse(f.output.at(-1)!)).toMatchObject({ id: 'saved', email: '' })
  expect(await f.run(['contact', 'rm', 'saved'])).toBe(0)
  expect(f.requests.at(-1)?.method).toBe('DELETE')
})

test('CLI refuses ambiguous names, builtin edits, empty updates and missing flag values', async () => {
  const base = fixture().saved
  const f = fixture([{ ...base, id: 'second', name: 'Kim Lee' }, { ...base, id: 'agent:knox', name: 'Knox', agent: 'knox', builtin: true }])
  expect(await f.run(['contact', 'update', 'Kim Lee', '--note', 'oops'])).toBe(1)
  expect(f.errors.at(-1)).toContain('ambiguous')
  expect(await f.run(['contact', 'rm', 'Knox'])).toBe(1)
  expect(f.errors.at(-1)).toContain('builtin')
  expect(await f.run(['contact', 'update', 'saved'])).toBe(1)
  expect(await f.run(['contact', 'update', 'saved', '--note', '--untrusted'])).toBe(1)
  expect(f.requests.every((r) => r.method === 'GET')).toBe(true)
})

test('MCP supports the full fleet and editing contacts through the shared API', async () => {
  const f = fixture()
  const server = createMcpServer(f.client)
  const client = new Client({ name: 'test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  await client.connect(b)
  try {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['list_contacts', 'get_contact', 'add_contact', 'update_contact', 'remove_contact']))
    for (const agent of ['rootkey', 'coinpay', 'knox']) {
      const result = await client.callTool({ name: 'add_contact', arguments: { name: agent, agent, email: `${agent}@profullstack.com` } })
      expect(result.isError).not.toBe(true)
      expect(f.requests.at(-1)?.body.agent).toBe(agent)
    }
    const result = await client.callTool({ name: 'update_contact', arguments: { id: 'saved', email: '', aliases: [], trusted: false } })
    expect(result.isError).not.toBe(true)
    expect(f.requests.at(-1)?.body).toEqual({ email: '', aliases: [], trusted: false })
    expect((await client.callTool({ name: 'get_contact', arguments: { reference: 'saved' } })).isError).not.toBe(true)
  } finally {
    await client.close()
    await server.close()
  }
})
