import { EDefinitionOrigin } from '@dltech/atlas-core'
import {
  EMcpServerStatus,
  type LoadedMcpSpec,
  type McpServerStatus,
} from '@dltech/atlas-harness'
import { describe, expect, it } from 'bun:test'

import { dispatchSubmission, EDispatch } from '../commands/dispatch'
import { localCommands } from '../commands/registry'
import {
  mcpBootNotice,
  mcpLayerOf,
  mcpReport,
  NO_MCP_SERVERS,
} from '../mcp-report'
import { handlers } from '../commands/__tests__/local-handlers'

const server = (args: {
  name: string
  origin?: EDefinitionOrigin | undefined
  definedIn?: string | undefined
  state: McpServerStatus['state']
  tools?: number | undefined
}): McpServerStatus => {
  const spec: LoadedMcpSpec = {
    name: args.name,
    origin: args.origin ?? EDefinitionOrigin.Project,
    definedIn: args.definedIn ?? '/repo/.atlas/mcp.json',
  }

  return {
    spec,
    state: args.state,
    tools: args.tools ?? 0,
  }
}

describe('the mcp report', () => {
  it('says there is nothing to inspect when no server names came back', () => {
    expect(mcpReport({ servers: [] })).toBe(NO_MCP_SERVERS)
  })

  it('describes a connected server as connected with its tool count', () => {
    const report = mcpReport({
      servers: [
        server({
          name: 'fs',
          state: { status: EMcpServerStatus.Connected },
          tools: 4,
        }),
      ],
    })

    expect(report).toContain('fs')
    expect(report).toContain('Connected')
    expect(report).toContain('4 tools')
  })

  it('describes a failed server as failed with the error it recorded', () => {
    const report = mcpReport({
      servers: [
        server({
          name: 'linear',
          state: {
            status: EMcpServerStatus.Failed,
            error: 'spawned process exited with code 1',
          },
        }),
      ],
    })

    expect(report).toContain('linear')
    expect(report).toContain('Failed(spawned process exited with code 1)')
  })

  it('describes a disabled server as disabled rather than as a mistake', () => {
    const report = mcpReport({
      servers: [server({ name: 'gh', state: { status: EMcpServerStatus.Disabled } })],
    })

    expect(report).toContain('gh')
    expect(report).toContain('Disabled')
    expect(report).not.toContain('Failed')
  })

  it('counts one tool in the singular', () => {
    const report = mcpReport({
      servers: [
        server({
          name: 'one',
          state: { status: EMcpServerStatus.Connected },
          tools: 1,
        }),
      ],
    })

    expect(report).toContain('1 tool')
    expect(report).not.toContain('1 tools')
  })
})

describe('the layer the report names for a server', () => {
  const layers = [
    { origin: EDefinitionOrigin.BuiltIn, definedIn: 'atlas', layer: 'BuiltIn' },
    { origin: EDefinitionOrigin.User, definedIn: '/home/atlas/mcp.json', layer: 'User' },
    { origin: EDefinitionOrigin.Project, definedIn: '/repo/.atlas/mcp.json', layer: 'Project' },
    { origin: EDefinitionOrigin.Project, definedIn: '/repo/.mcp.json', layer: 'Project-compat' },
  ]

  it('names each origin and the compat file distinctly', () => {
    for (const { origin, definedIn, layer } of layers) {
      expect(mcpLayerOf({ definedIn, origin })).toBe(layer)
    }
  })
})

describe('the mcp command', () => {
  it('echoes the report it is handed back', async () => {
    const dispatched = await dispatchSubmission({
      text: '/mcp',
      commands: localCommands(handlers({ onShowMcp: () => 'fs Connected 4 tools Project' })),
      skills: [],
    })

    expect(dispatched).toEqual({ type: EDispatch.Ran, notice: 'fs Connected 4 tools Project' })
  })

  it('says there is nothing to inspect rather than producing a blank notice', async () => {
    const dispatched = await dispatchSubmission({
      text: '/mcp',
      commands: localCommands(handlers({ onShowMcp: () => NO_MCP_SERVERS })),
      skills: [],
    })

    expect(dispatched.type).toBe(EDispatch.Ran)
    expect(dispatched.type === EDispatch.Ran && dispatched.notice).toBe(NO_MCP_SERVERS)
  })

  it('carries a summary /help can read out', () => {
    const mcp = localCommands(handlers()).find((one) => one.name === 'mcp')

    expect(mcp?.summary).toBe('inspect the MCP servers this workspace is configured with')
  })
})

describe('the boot notice', () => {
  it('reports only the servers that failed, because connected ones are not news', () => {
    const failed = server({
      name: 'linear',
      state: { status: EMcpServerStatus.Failed, error: 'spawn refused' },
    })
    const connected = server({ name: 'fs', state: { status: EMcpServerStatus.Connected } })
    const disabled = server({ name: 'gh', state: { status: EMcpServerStatus.Disabled } })

    expect(mcpBootNotice(failed)).toBe('linear Failed(spawn refused) 0 tools Project')
    expect(mcpBootNotice(connected)).toBe(null)
    expect(mcpBootNotice(disabled)).toBe(null)
  })
})
