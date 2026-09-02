import type {
  McpCapabilities,
  McpToolInfo,
  McpToolResult,
  ServerTransport,
} from '../transport'

export class InMemoryTransport implements ServerTransport {
  tools: McpToolInfo[] = []
  capabilities: McpCapabilities = { tools: true, prompts: false, resources: false }
  response: McpToolResult | ((args: { input: unknown }) => McpToolResult) = {
    content: [{ type: 'text', text: 'ok' }],
  }
  failsConnect = false

  connected = false
  closed = false
  connectDelayMs = 0

  readonly calls: { name: string; input: unknown }[] = []

  connect(): Promise<McpCapabilities> {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (this.failsConnect) {
          reject(new Error('the fixture refused to connect'))
          return
        }
        this.connected = true
        resolve(this.capabilities)
      }, this.connectDelayMs)
    })
  }

  listTools(): Promise<McpToolInfo[]> {
    return Promise.resolve(this.tools)
  }

  callTool(args: { name: string; input: unknown }): Promise<McpToolResult> {
    this.calls.push(args)
    const response = typeof this.response === 'function' ? this.response({ input: args.input }) : this.response
    return Promise.resolve(response)
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

export const toolInfo = (args: {
  name: string
  description?: string
  annotations?: unknown
  inputSchema?: unknown
}): McpToolInfo => ({
  name: args.name,
  ...(args.description !== undefined ? { description: args.description } : {}),
  ...(args.inputSchema !== undefined ? { inputSchema: args.inputSchema } : {}),
  ...(args.annotations !== undefined ? { annotations: args.annotations } : {}),
})
