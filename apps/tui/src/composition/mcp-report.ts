import { EDefinitionOrigin } from '@dltech/atlas-core'

import {
  COMPAT_MCP_FILE_NAME,
  EMcpServerStatus,
  type McpServerStatus,
} from '@dltech/atlas-harness'

export const NO_MCP_SERVERS = 'no MCP servers are configured'

const layerNameOf = (origin: EDefinitionOrigin): string => {
  if (origin === EDefinitionOrigin.BuiltIn) return 'BuiltIn'
  if (origin === EDefinitionOrigin.User) return 'User'
  return 'Project'
}

export const mcpLayerOf = (args: { definedIn: string; origin: EDefinitionOrigin }): string =>
  args.definedIn.endsWith(COMPAT_MCP_FILE_NAME) ? 'Project-compat' : layerNameOf(args.origin)

const statusLabelOf = (server: McpServerStatus): string => {
  if (server.state.status === EMcpServerStatus.Connected) return 'Connected'
  if (server.state.status === EMcpServerStatus.Disabled) return 'Disabled'
  return `Failed(${server.state.error})`
}

const toolCountOf = (server: McpServerStatus): string =>
  `${server.tools} tool${server.tools === 1 ? '' : 's'}`

export const mcpRow = (server: McpServerStatus): string =>
  `${server.spec.name} ${statusLabelOf(server)} ${toolCountOf(server)} ${mcpLayerOf({ definedIn: server.spec.definedIn, origin: server.spec.origin })}`

export function mcpReport(args: { servers: readonly McpServerStatus[] }): string {
  if (args.servers.length === 0) return NO_MCP_SERVERS
  return args.servers.map(mcpRow).join('\n')
}

export const mcpBootNotice = (server: McpServerStatus): string | null =>
  server.state.status === EMcpServerStatus.Failed ? mcpRow(server) : null
