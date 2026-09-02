import { describe, expect, it } from 'bun:test'

import { HttpTransport } from '../transport/http'
import type { JsonRpcId, JsonRpcMessage } from '../transport/transport'

type Capture = { headers: Headers; body: string }

type FetchInit = Parameters<typeof fetch>[1] | undefined

const capture = (url: string | URL | Request, init: FetchInit): Capture => ({
  headers: new Headers(init?.headers as Record<string, string> | undefined),
  body: typeof init?.body === 'string' ? init.body : '',
})

const reply = (id: JsonRpcId, result: unknown): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const stream = (id: JsonRpcId, result: unknown, session: string | undefined): Response => {
  const payload = [
    `event: message`,
    `data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}`,
    ``,
    ``,
  ]
  const response = new Response(payload.join('\n'), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
  if (session !== undefined) response.headers.set('mcp-session-id', session)
  return response
}

const withFetch = async <T>(args: {
  handler: (url: string | URL | Request, init: FetchInit, captures: Capture[]) => Response
  run: (captures: Capture[]) => Promise<T>
}): Promise<T> => {
  const original = globalThis.fetch
  const captures: Capture[] = []
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request, init: FetchInit) => {
      const captured = capture(url, init)
      captures.push(captured)
      return args.handler(url, init, captures)
    },
    { preconnect: original.preconnect },
  )
  try {
    return await args.run(captures)
  } finally {
    globalThis.fetch = original
  }
}

describe('HttpTransport', () => {
  it('connects, captures headers, and parses capabilities', async () => {
    await withFetch({
      handler: (url, init, captures) => {
        const inbound = JSON.parse(captures[captures.length - 1]?.body ?? '') as JsonRpcMessage
        return reply(inbound.id ?? 'null', {
          capabilities: { tools: {} },
          instructions: 'http instructions',
        })
      },
      run: async (captures) => {
        const transport = new HttpTransport({ kind: 'http', url: 'https://example.test/mcp' })
        const capabilities = await transport.connect()

        expect(captures[0]?.headers.get('content-type')).toBe('application/json')
        expect(captures[0]?.headers.get('accept')).toBe('application/json, text/event-stream')
        expect(capabilities).toEqual({
          tools: true,
          prompts: false,
          resources: false,
          instructions: 'http instructions',
        })
      },
    })
  })

  it('posts the spec headers over the wire', async () => {
    await withFetch({
      handler: (url, init, captures) => {
        const inbound = JSON.parse(captures[captures.length - 1]?.body ?? '') as JsonRpcMessage
        return reply(inbound.id ?? 'null', {})
      },
      run: async (captures) => {
        const transport = new HttpTransport({
          kind: 'http',
          url: 'https://example.test/mcp',
          headers: { authorization: 'Bearer token-1', 'x-custom': 'atlas' },
        })
        await transport.connect()

        expect(captures[0]?.headers.get('authorization')).toBe('Bearer token-1')
        expect(captures[0]?.headers.get('x-custom')).toBe('atlas')
      },
    })
  })

  it('parses an SSE response when the server streams', async () => {
    await withFetch({
      handler: (url, init, captures) => {
        const inbound = JSON.parse(captures[captures.length - 1]?.body ?? '') as JsonRpcMessage
        return stream(inbound.id ?? 'null', { capabilities: { tools: {} } }, undefined)
      },
      run: async () => {
        const transport = new HttpTransport({ kind: 'http', url: 'https://example.test/mcp' })
        const capabilities = await transport.connect()

        expect(capabilities.tools).toBe(true)
      },
    })
  })

  it('publishes a json-rpc error body as a thrown error', async () => {
    await withFetch({
      handler: (url, init, captures) => {
        const inbound = JSON.parse(captures[captures.length - 1]?.body ?? '') as JsonRpcMessage
        const response = new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: inbound.id,
            error: { code: -32000, message: 'the server said no' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
        return response
      },
      run: async () => {
        const transport = new HttpTransport({ kind: 'http', url: 'https://example.test/mcp' })
        await expect(transport.connect()).rejects.toThrow('the server said no')
      },
    })
  })

  it('remembers the session id across calls and closes with it', async () => {
    await withFetch({
      handler: (url, init, captures) => {
        const inbound = JSON.parse(captures[captures.length - 1]?.body ?? '') as JsonRpcMessage
        return stream(inbound.id ?? 'null', {}, 'session-1')
      },
      run: async (captures) => {
        const transport = new HttpTransport({ kind: 'http', url: 'https://example.test/mcp' })
        await transport.connect()
        await transport.close()

        expect(captures[captures.length - 1]?.headers.get('mcp-session-id')).toBe('session-1')
      },
    })
  })
})
