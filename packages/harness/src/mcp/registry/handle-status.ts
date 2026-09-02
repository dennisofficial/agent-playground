import type { LoadedMcpSpec } from '../config'
import type { McpCapabilities, ServerTransport } from '../transport'

export enum EMcpServerStatus {
  Connected = 'connected',
  Failed = 'failed',
  Disabled = 'disabled',
}

export type McpHandleState =
  | { status: EMcpServerStatus.Connected }
  | { status: EMcpServerStatus.Failed; error: string }
  | { status: EMcpServerStatus.Disabled }

export type McpHandle = {
  spec: LoadedMcpSpec
  transport: ServerTransport
  capabilities: McpCapabilities | undefined
  state: McpHandleState
}

export type McpServerStatus = {
  spec: LoadedMcpSpec
  state: McpHandleState
  tools: number
}
