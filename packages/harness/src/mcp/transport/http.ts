import type { McpTransport } from '../config/specs'
import {
  parseCapabilities,
  parseToolList,
  parseToolResult,
  type JsonRpcId,
  type JsonRpcMessage,
  type McpCapabilities,
  type McpJson,
  type McpToolInfo,
  type McpToolResult,
  type ServerTransport,
} from './transport'

type HttpTransportSpec = Extract<McpTransport, { kind: 'http' }>

const REQUEST_TIMEOUT_MS = 30_000

const ACCEPTED = 'application/json, text/event-stream'
const JSON_TYPE = 'application/json'
const SSE_TYPE = 'text/event-stream'

export class HttpTransport implements ServerTransport {
  private session: string | undefined
  private nextId = 1
  private closed = false

  constructor(private readonly spec: HttpTransportSpec) {}

  connect(): Promise<McpCapabilities> {
    if (this.closed) return Promise.reject(new Error('the transport is closed'))

    return this.request({
      method: 'initialize',
      params: {
        // https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle — pinned across clients
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'atlas', version: '0.1.0' },
      },
    }).then((result) => parseCapabilities(result as McpJson | undefined))
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.request({ method: 'tools/list' })
    return parseToolList(result as McpJson | undefined)
  }

  async callTool(args: { name: string; input: unknown }): Promise<McpToolResult> {
    const params: McpJson =
      args.input === null
        ? { name: args.name }
        : { name: args.name, arguments: args.input as McpJson }
    const result = await this.request({ method: 'tools/call', params })
    return parseToolResult(result as McpJson | undefined)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const session = this.session
    if (session === undefined) return
    try {
      await fetch(this.spec.url, {
        method: 'DELETE',
        headers: this.headers({ accept: 'application/json' }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
    }
  }

  private headers(args: { accept: string }): Record<string, string> {
    return {
      ...(this.spec.headers ?? {}),
      'content-type': JSON_TYPE,
      accept: args.accept,
      ...(this.session !== undefined ? { 'mcp-session-id': this.session } : {}),
    }
  }

  private async request(args: { method: string; params?: McpJson }): Promise<McpJson | undefined> {
    if (this.closed) return Promise.reject(new Error('the transport is closed'))
    const id = String(this.nextId++)
    const body = JSON.stringify({ jsonrpc: '2.0', id, ...args } as JsonRpcMessage)

    const response = await fetch(this.spec.url, {
      method: 'POST',
      headers: this.headers({ accept: ACCEPTED }),
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    const sessionId = response.headers.get('mcp-session-id')
    if (sessionId !== null) this.session = sessionId

    if (!response.ok) {
      throw new Error(`http ${response.status}: ${await response.text()}`)
    }
    const contentType = contentOf(response.headers.get('content-type'))
    if (contentType === SSE_TYPE) {
      return parseStream(await response.text(), id)
    }
    if (contentType !== JSON_TYPE) {
      throw new Error(`unexpected content-type ${response.headers.get('content-type')}`)
    }
    const text = await response.text()
    return parseReply(text, id)
  }
}

const contentOf = (contentType: string | null): string | undefined =>
  contentType === null ? undefined : contentType.split(';', 1)[0]?.trim()

function parseReply(text: string, id: JsonRpcId): McpJson | undefined {
  const message = JSON.parse(text) as JsonRpcMessage
  if (message.error !== undefined) {
    throw new Error(message.error.message)
  }
  if (message.id === id) return message.result
  return undefined
}

function parseStream(text: string, id: JsonRpcId): McpJson | undefined {
  for (const event of splitEvents(text)) {
    const data = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('')
    if (data.length === 0) continue
    const message = JSON.parse(data) as JsonRpcMessage
    if (message.id !== id) continue
    if (message.error !== undefined) {
      throw new Error(message.error.message)
    }
    return message.result
  }
  return undefined
}

function splitEvents(text: string): string[] {
  return text
    .split(/\r?\n\r?\n/)
    .map((event) => event.trim())
    .filter((event) => event.length > 0)
}
