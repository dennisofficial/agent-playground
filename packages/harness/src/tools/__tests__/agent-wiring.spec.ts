import { tmpdir } from 'node:os'

import { afterAll, describe, expect, it } from 'bun:test'

import { EDefinitionOrigin, EWebSearchBackend, ToolDefinition } from '@dltech/atlas-core'

import { AgentRegistryPort } from '../../agents/registry/port'
import type { AgentType } from '../../agents/types/agent-type'
import { createHarnessContainer } from '../../container/create-harness-container'
import { portToken, resolveSet, type DependencyContainer } from '../../container/injection'
import {
  PrismaClientToken,
  WebSearchBackendToken,
  WorktreeDirectoryToken,
  WorkspaceRoot,
} from '../../container/tokens'
import { createTempDatabase, type TempDatabase } from '../../loop/__tests__/temp-database'
import { openAtlasDatabase } from '../../store'
import { AgentTypesToken } from '../builtin/agent-tokens'
import { ToolRegistry } from '../registry'

const AGENT_TOOLS = ['agent_list', 'agent_resume', 'agent_say', 'agent_spawn', 'agent_stop']

const opened: { close: () => Promise<void>; temp: TempDatabase }[] = []

const wired = (): DependencyContainer => {
  const container = createHarnessContainer()
  container.register(WorkspaceRoot, { useValue: tmpdir() })
  container.register(WorktreeDirectoryToken, { useValue: () => '.atlas/worktrees' })
  container.register(WebSearchBackendToken, { useValue: () => EWebSearchBackend.DuckDuckGo })
  return container
}

async function withDatabase(): Promise<DependencyContainer> {
  const temp = createTempDatabase()
  const database = await openAtlasDatabase({ databaseUrl: temp.databaseUrl })
  opened.push({ close: database.close, temp })

  const container = wired()
  container.register(PrismaClientToken, { useValue: database.prisma })
  return container
}

const toolNamed = ({
  container,
  name,
}: {
  container: DependencyContainer
  name: string
}): ToolDefinition => {
  const found = resolveSet({ container, token: portToken(ToolDefinition) }).find(
    (tool) => tool.name === name,
  )
  if (found === undefined) throw new Error(`the container resolved no tool named "${name}"`)
  return found
}

afterAll(async () => {
  for (const entry of opened.splice(0)) {
    await entry.close()
    entry.temp.discard()
  }
})

describe('the agent tools the container hands out', () => {
  it('resolves all five without recursing back through the tool registry that builds them', () => {
    const names = resolveSet({ container: wired(), token: portToken(ToolDefinition) })
      .map((tool) => tool.name)
      .filter((name) => name.startsWith('agent_'))
      .sort()

    expect(names).toEqual(AGENT_TOOLS)
  })

  it('resolves the whole tool registry without a database, as every other tool does', () => {
    const declared = wired()
      .resolve(portToken(ToolRegistry))
      .declarations()
      .map((declaration) => declaration.name)

    expect(declared).toContain('agent_spawn')
  })

  it('builds the spawn description from the registered types rather than from a written list', () => {
    const container = wired()
    const types = container.resolve(AgentTypesToken)

    expect(types.length).toBeGreaterThan(0)
    for (const type of types) {
      expect(toolNamed({ container, name: 'agent_spawn' }).description).toContain(
        `- ${type.name}: ${type.whenToUse}`,
      )
    }
  })

  it('names a type nobody built in, when the composition root supplies its own', () => {
    const invented: AgentType = {
      name: 'archaeologist',
      whenToUse: 'digs through the history of a file',
      prompt: 'You dig.',
      origin: EDefinitionOrigin.Project,
    }

    const container = wired()
    container.register(AgentTypesToken, { useValue: [invented] })

    const description = toolNamed({ container, name: 'agent_spawn' }).description
    expect(description).toContain('- archaeologist: digs through the history of a file')
    expect(description).not.toContain('- explore:')
  })

  it('hands every tool the same supervisor once a database exists', async () => {
    const container = await withDatabase()

    expect(container.resolve(portToken(AgentRegistryPort))).toBe(
      container.resolve(portToken(AgentRegistryPort)),
    )
  })

  it('gives that supervisor the agent types the container registered', async () => {
    const container = await withDatabase()

    expect(container.resolve(portToken(AgentRegistryPort)).types()).toEqual(
      container.resolve(AgentTypesToken),
    )
  })
})
