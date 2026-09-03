import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

import { StdioTransport } from '../transport/stdio'
import type { ServerTransport } from '../transport/transport'

const FIXTURE = join(__dirname, 'fixture-server.ts')
const NOISY_FIXTURE = join(__dirname, 'fixture-noisy-server.ts')

const spec = { kind: 'stdio' as const, command: 'bun', args: [FIXTURE] }

const spawnFixture = (): ServerTransport => new StdioTransport(spec)

describe('StdioTransport', () => {
  it('connects, lists tools, and closes the child', async () => {
    const transport = spawnFixture()

    const capabilities = await transport.connect()

    expect(capabilities).toEqual({
      tools: true,
      prompts: false,
      resources: true,
      instructions: 'fixture server instructions',
    })

    const tools = await transport.listTools()
    expect(tools).toEqual([
      {
        name: 'echo',
        description: 'echo the arguments back',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
      },
    ])

    await transport.close()
  })

  it('answers a tool call with content and structured content', async () => {
    const transport = spawnFixture()
    await transport.connect()

    const result = await transport.callTool({ name: 'echo', input: { a: 1 } })

    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify('echo') }],
      structuredContent: { ok: true },
      isError: false,
    })

    await transport.close()
  })

  it('surfaces a json-rpc error rather than timing out', async () => {
    const transport = spawnFixture()
    await transport.connect()

    await expect(transport.callTool({ name: 'throw', input: {} })).rejects.toThrow(
      'the fixture threw',
    )

    await transport.close()
  })

  it('serves a server that floods stderr without stalling the protocol', async () => {
    const transport = new StdioTransport({ kind: 'stdio', command: 'bun', args: [NOISY_FIXTURE] })

    const capabilities = await transport.connect()
    expect(capabilities.tools).toBe(true)

    const result = await transport.callTool({ name: 'echo', input: {} })
    expect(result.isError).toBe(false)

    await transport.close()
  })

  it('refuses to connect twice', async () => {
    const transport = spawnFixture()
    await transport.connect()

    await expect(transport.connect()).rejects.toThrow('already connected')

    await transport.close()
  })
})
