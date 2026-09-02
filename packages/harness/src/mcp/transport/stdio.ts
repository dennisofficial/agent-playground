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

type StdioTransportSpec = Extract<McpTransport, { kind: 'stdio' }>

type Pending = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

const REQUEST_TIMEOUT_MS = 30_000
const CLOSE_GRACE_MS = 2_000

const INITIALIZATION = {
  // https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle — pinned across clients
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'atlas', version: '0.1.0' },
} as unknown as McpJson

const scrubEnv = (extra: Record<string, string> | undefined): Record<string, string> => ({
  ...(process.env['PATH'] !== undefined ? { PATH: process.env['PATH'] } : {}),
  ...(process.env['HOME'] !== undefined ? { HOME: process.env['HOME'] } : {}),
  ...(extra ?? {}),
})

export class StdioTransport implements ServerTransport {
  private child: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined
  private readonly pending = new Map<JsonRpcId, Pending>()
  private nextId = 1
  private closed = false

  constructor(private readonly spec: StdioTransportSpec) {}

  connect(): Promise<McpCapabilities> {
    if (this.child !== undefined) return Promise.reject(new Error('the transport is already connected'))
    if (this.closed) return Promise.reject(new Error('the transport is closed'))

    this.child = Bun.spawn({
      cmd: [this.spec.command, ...(this.spec.args ?? [])],
      env: scrubEnv(this.spec.env),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    this.consume()

    return this.request({ method: 'initialize', params: INITIALIZATION }).then((result) =>
      parseCapabilities(result as McpJson | undefined),
    )
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
    if (this.child !== undefined) {
      this.child.stdin.end()
      const exited = await Promise.race([
        this.child.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(false), CLOSE_GRACE_MS)
        }),
      ])
      if (!exited) this.child.kill()
      await this.child.exited.catch(() => undefined)
    }
    this.rejectAll(new Error('the transport closed before a response could be read'))
  }

  private request(args: { method: string; params?: McpJson }): Promise<unknown> {
    if (this.child === undefined) {
      return Promise.reject(new Error('the transport is not connected'))
    }
    if (this.closed) {
      return Promise.reject(new Error('the transport is closed'))
    }
    const id = String(this.nextId++)
    let timeout: ReturnType<typeof setTimeout> | undefined
    const promise = new Promise<unknown>((resolve, reject) => {
      timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`request ${id} timed out after ${REQUEST_TIMEOUT_MS} ms`))
      }, REQUEST_TIMEOUT_MS)
      timeout.unref?.()
      this.pending.set(id, { resolve, reject })
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...args })}\n`)
      this.child?.stdin.flush()
    })
    return promise.finally(() => clearTimeout(timeout))
  }

  private consume(): void {
    const stdout = this.child?.stdout
    if (stdout === undefined) return
    const reader = stdout.getReader()
    const decoder = new TextDecoder()
    const drain = async () => {
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        buffer = this.lines(buffer)
      }
      if (buffer.length > 0) this.parse(buffer)
    }
    drain().catch(() => undefined)

    void this.child?.exited.then(() => {
      this.rejectAll(new Error('the child exited before it could answer'))
    }).catch(() => undefined)
  }

  private lines(buffer: string): string {
    let remainder = buffer
    for (;;) {
      const index = remainder.indexOf('\n')
      if (index === -1) return remainder
      this.parse(remainder.slice(0, index))
      remainder = remainder.slice(index + 1)
    }
  }

  private parse(line: string): void {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let message: JsonRpcMessage
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage
    } catch {
      return
    }
    if (message.method !== undefined) return
    const id = message.id
    if (id === undefined) return
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    if (message.error !== undefined) {
      pending.reject(new Error(message.error.message))
      return
    }
    pending.resolve(message.result)
  }

  private rejectAll(reason: Error): void {
    if (this.pending.size === 0) return
    for (const [, pending] of this.pending) pending.reject(reason)
    this.pending.clear()
  }
}
