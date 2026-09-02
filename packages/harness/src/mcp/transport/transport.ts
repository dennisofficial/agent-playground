export type McpCapabilities = {
  tools: boolean
  prompts: boolean
  resources: boolean
  instructions?: string
}

export type McpToolInfo = {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: unknown
}

export type McpToolResult = {
  content?: unknown
  structuredContent?: unknown
  isError?: boolean
}

export interface ServerTransport {
  connect(): Promise<McpCapabilities>
  listTools(): Promise<McpToolInfo[]>
  callTool(args: { name: string; input: unknown }): Promise<McpToolResult>
  close(): Promise<void>
}

export type McpJson = string | number | boolean | null | McpJson[] | { [key: string]: McpJson }

export type JsonRpcId = string | number

export type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: McpJson
}

export type JsonRpcMessage = {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method?: string
  params?: McpJson
  result?: McpJson
  error?: { code: number; message: string; data?: unknown }
}

export const asRecord = (value: McpJson | undefined): Record<string, McpJson> | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, McpJson>
}

export function parseCapabilities(result: McpJson | undefined): McpCapabilities {
  const envelope = asRecord(result) ?? {}
  const capabilities = asRecord(envelope['capabilities']) ?? {}
  return {
    tools: capabilities['tools'] !== undefined,
    prompts: capabilities['prompts'] !== undefined,
    resources: capabilities['resources'] !== undefined,
    ...(typeof envelope['instructions'] === 'string' ? { instructions: envelope['instructions'] } : {}),
  }
}

const parseToolEntry = (entry: McpJson): McpToolInfo => {
  const raw = asRecord(entry) ?? {}
  return {
    name: typeof raw['name'] === 'string' ? raw['name'] : '',
    ...(raw['description'] !== undefined ? { description: raw['description'] as unknown as string } : {}),
    ...(raw['inputSchema'] !== undefined ? { inputSchema: raw['inputSchema'] } : {}),
    ...(raw['annotations'] !== undefined ? { annotations: raw['annotations'] } : {}),
  }
}

export function parseToolList(result: McpJson | undefined): McpToolInfo[] {
  const envelope = asRecord(result) ?? {}
  const tools = envelope['tools']
  return (Array.isArray(tools) ? tools : []).map(parseToolEntry)
}

export function parseToolResult(result: McpJson | undefined): McpToolResult {
  const envelope = asRecord(result) ?? {}
  return {
    ...(envelope['content'] !== undefined ? { content: envelope['content'] } : {}),
    ...(envelope['structuredContent'] !== undefined ? { structuredContent: envelope['structuredContent'] } : {}),
    ...(typeof envelope['isError'] === 'boolean' ? { isError: envelope['isError'] } : {}),
  }
}
