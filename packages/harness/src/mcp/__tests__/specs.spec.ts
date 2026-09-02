import { describe, expect, it } from 'bun:test'

import { MCP_SERVERS_FIELD, mcpConfigFileSchema, mcpServersOf, mcpSpecSchema } from '../config/specs'

const stdio = { kind: 'stdio', command: 'npx' } as const
const http = { kind: 'http', url: 'https://example.test/mcp' } as const

const names = (parsed: unknown): boolean => mcpSpecSchema.safeParse(parsed).success

describe('mcpSpecSchema', () => {
  it('takes a stdio server with the full field set', () => {
    const parsed = mcpSpecSchema.parse({
      name: 'linear',
      transport: { ...stdio, args: ['-y', '@linear/mcp'], env: { LINEAR_KEY: 'x' } },
      disabled: false,
      trusted: true,
    })

    expect(parsed.transport).toEqual({ ...stdio, args: ['-y', '@linear/mcp'], env: { LINEAR_KEY: 'x' } })
    expect(parsed.trusted).toBe(true)
  })

  it('takes an http server with headers', () => {
    const parsed = mcpSpecSchema.parse({
      name: 'docs',
      transport: { ...http, headers: { authorization: 'Bearer x' } },
    })

    expect(parsed.transport).toEqual({ ...http, headers: { authorization: 'Bearer x' } })
  })

  it.each(['alpha', 'A9_-z', 'mcp_server-2'])('accepts the name %s', (name) => {
    expect(names({ name, transport: stdio })).toBe(true)
  })

  it.each(['has space', 'dots.name', 'slash/name', '', 'unicodé'])(
    'rejects the name "%s"',
    (name) => {
      expect(names({ name, transport: stdio })).toBe(false)
    },
  )

  it('demands a transport unless the entry is disabled', () => {
    expect(names({ name: 'linear' })).toBe(false)
    expect(names({ name: 'linear', disabled: false })).toBe(false)
    expect(names({ name: 'linear', disabled: true })).toBe(true)
  })

  it('still takes a disabled entry that carries a transport', () => {
    expect(names({ name: 'linear', disabled: true, transport: stdio })).toBe(true)
  })

  it('rejects a url that is not http or https', () => {
    expect(names({ name: 'x', transport: { kind: 'http', url: 'not a url' } })).toBe(false)
    expect(names({ name: 'x', transport: { kind: 'http', url: 'ftp://example.test' } })).toBe(false)
  })

  it('rejects a transport kind outside the union', () => {
    expect(names({ name: 'x', transport: { kind: 'sse', url: 'https://example.test' } })).toBe(false)
  })

  it('rejects unknown fields rather than silently dropping them', () => {
    expect(names({ name: 'x', transport: stdio, timeout: 30 })).toBe(false)
    expect(names({ name: 'x', transport: { ...stdio, retries: 2 } })).toBe(false)
  })

  it('rejects a stdio server with no command to spawn', () => {
    expect(names({ name: 'x', transport: { kind: 'stdio', command: '' } })).toBe(false)
  })
})

describe('mcpConfigFileSchema', () => {
  it('reads the bare shape Claude Code writes', () => {
    const file = mcpConfigFileSchema.parse({ linear: { transport: stdio } })

    expect(mcpServersOf(file)).toEqual({ linear: { transport: stdio } })
  })

  it('reads the wrapped mcpServers shape', () => {
    const file = mcpConfigFileSchema.parse({ [MCP_SERVERS_FIELD]: { linear: { transport: stdio } } })

    expect(mcpServersOf(file)).toEqual({ linear: { transport: stdio } })
  })

  it('refuses anything that is not an object of servers', () => {
    expect(mcpConfigFileSchema.safeParse(['linear']).success).toBe(false)
    expect(mcpConfigFileSchema.safeParse('linear').success).toBe(false)
    expect(mcpConfigFileSchema.safeParse(null).success).toBe(false)
  })

  it('reads an empty object as an empty server set', () => {
    expect(mcpServersOf(mcpConfigFileSchema.parse({}))).toEqual({})
  })
})
