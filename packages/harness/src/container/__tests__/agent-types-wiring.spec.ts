import { afterEach, describe, expect, it } from 'bun:test'

import { EDefinitionOrigin } from '@dltech/atlas-core'

import { AgentRegistryPort } from '../../agents/registry/port'
import {
  AGENT_SPAWN_TOOL_NAME,
  EAgentTypeRefusal,
  type AgentType,
  type AgentTypeSource,
} from '../../agents/types'
import { AgentTypeCatalogToken, bindAgentTypes } from '../../agents/types/bind-agent-types'
import { DirectoryAgentTypeSource } from '../../agents/types/directory-source'
import { EmbeddedAgentTypeSource } from '../../agents/types/embedded-source'
import { createTempDatabase, type TempDatabase } from '../../loop/__tests__/temp-database'
import { scriptedModel } from '../../model/testing/scripted-model'
import { openAtlasDatabase } from '../../store/database'
import { ToolRegistry } from '../../tools/registry'
import { createHarnessContainer } from '../create-harness-container'
import { portToken, type DependencyContainer } from '../injection'
import { LanguageModelToken, PrismaClientToken, WorkspaceRoot } from '../tokens'

const ROOT = '/workspace/atlas'

const opened: { close: () => Promise<void>; temp: TempDatabase }[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.close()
    entry.temp.discard()
  }
})

const definition = (args: {
  description: string
  tools?: string
  model?: string
  body?: string
}): string =>
  [
    '---',
    `description: ${args.description}`,
    ...(args.tools === undefined ? [] : [`tools: ${args.tools}`]),
    ...(args.model === undefined ? [] : [`model: ${args.model}`]),
    '---',
    args.body ?? 'Prompt.',
  ].join('\n')

const AGENTS_DIRECTORY = `${ROOT}/.atlas/agents`

const directoryOf = (args: {
  origin: EDefinitionOrigin
  files: readonly { name: string; text: string }[]
}): AgentTypeSource =>
  new DirectoryAgentTypeSource({
    directory: AGENTS_DIRECTORY,
    origin: args.origin,
    read: async () => ({
      files: args.files.map((file) => ({ ...file, path: `${AGENTS_DIRECTORY}/${file.name}` })),
      unreadable: [],
    }),
  })

async function harnessContainer(): Promise<DependencyContainer> {
  const temp = createTempDatabase()
  const database = await openAtlasDatabase({ databaseUrl: temp.databaseUrl })
  opened.push({ close: database.close, temp })

  const container = createHarnessContainer()
  container.register(WorkspaceRoot, { useValue: ROOT })
  container.register(PrismaClientToken, { useValue: database.prisma })
  container.register(LanguageModelToken, { useValue: scriptedModel({ script: [{ text: 'hi' }] }) })

  return container
}

const spawnDescription = (container: DependencyContainer): string =>
  container.resolve(portToken(ToolRegistry)).find(AGENT_SPAWN_TOOL_NAME)?.description ?? ''

const spawnableTypes = (container: DependencyContainer): readonly AgentType[] =>
  container.resolve(portToken(AgentRegistryPort)).types()

describe('agent types loaded from a directory', () => {
  it('reaches the description agent_spawn shows the model', async () => {
    const container = await harnessContainer()

    await bindAgentTypes({
      container,
      sources: [
        new EmbeddedAgentTypeSource(),
        directoryOf({
          origin: EDefinitionOrigin.Project,
          files: [{ name: 'migrator.md', text: definition({ description: 'move a schema' }) }],
        }),
      ],
    })

    expect(spawnDescription(container)).toContain('- migrator: move a schema')
  })

  it('is spawnable, and keeps the built-ins as the layer beneath it', async () => {
    const container = await harnessContainer()

    await bindAgentTypes({
      container,
      sources: [
        new EmbeddedAgentTypeSource(),
        directoryOf({
          origin: EDefinitionOrigin.User,
          files: [{ name: 'migrator.md', text: definition({ description: 'move a schema' }) }],
        }),
      ],
    })

    const names = spawnableTypes(container).map((agentType) => agentType.name)
    expect(names).toContain('migrator')
    expect(names).toContain('explore')
    expect(names).toContain('general-purpose')
  })

  it('lets a user file shadow the built-in of the same name', async () => {
    const container = await harnessContainer()

    await bindAgentTypes({
      container,
      sources: [
        new EmbeddedAgentTypeSource(),
        directoryOf({
          origin: EDefinitionOrigin.User,
          files: [
            {
              name: 'explore.md',
              text: definition({ description: 'search the way I like it', body: 'My prompt.' }),
            },
          ],
        }),
      ],
    })

    const explore = spawnableTypes(container).find((agentType) => agentType.name === 'explore')
    expect(explore?.origin).toBe(EDefinitionOrigin.User)
    expect(explore?.prompt).toBe('My prompt.')
    expect(spawnDescription(container)).toContain('- explore: search the way I like it')
  })

  it('cannot grant itself agent_spawn, however the file asks', async () => {
    const container = await harnessContainer()

    await bindAgentTypes({
      container,
      sources: [
        new EmbeddedAgentTypeSource(),
        directoryOf({
          origin: EDefinitionOrigin.Project,
          files: [
            {
              name: 'recursive.md',
              text: definition({
                description: 'spawn all the way down',
                tools: `read, ${AGENT_SPAWN_TOOL_NAME}`,
              }),
            },
          ],
        }),
      ],
    })

    const types = spawnableTypes(container)
    const recursive = types.find((agentType) => agentType.name === 'recursive')
    expect(recursive?.tools).toEqual(['read'])
    expect(recursive?.disallowedTools).toEqual([AGENT_SPAWN_TOOL_NAME])

    for (const agentType of types) {
      expect(agentType.disallowedTools).toContain(AGENT_SPAWN_TOOL_NAME)
    }
  })

  it('reaches nothing once the agent registry has already been resolved', async () => {
    const container = await harnessContainer()

    expect(spawnableTypes(container).map((agentType) => agentType.name)).not.toContain('migrator')

    await bindAgentTypes({
      container,
      sources: [
        new EmbeddedAgentTypeSource(),
        directoryOf({
          origin: EDefinitionOrigin.Project,
          files: [{ name: 'migrator.md', text: definition({ description: 'move a schema' }) }],
        }),
      ],
    })

    expect(spawnableTypes(container).map((agentType) => agentType.name)).not.toContain('migrator')
  })
})

describe('what an operator would need to see', () => {
  it('keeps the refusals beside the types, on a token a listing can resolve', async () => {
    const container = await harnessContainer()

    await bindAgentTypes({
      container,
      sources: [
        new EmbeddedAgentTypeSource(),
        directoryOf({
          origin: EDefinitionOrigin.Project,
          files: [
            { name: 'migrator.md', text: definition({ description: 'move a schema' }) },
            { name: 'broken.md', text: 'no frontmatter here' },
          ],
        }),
      ],
    })

    const catalog = container.resolve(AgentTypeCatalogToken)

    expect(catalog.types.map((agentType) => agentType.name)).toContain('migrator')
    expect(catalog.refusals).toHaveLength(1)
    expect(catalog.refusals[0]?.definedIn).toBe(`${AGENTS_DIRECTORY}/broken.md`)
    expect(catalog.refusals[0]?.refusal).toBe(EAgentTypeRefusal.NoDescription)
  })

  it('reports a pinned model this build cannot reach, and does not offer the type', async () => {
    const container = await harnessContainer()

    const catalog = await bindAgentTypes({
      container,
      sources: [
        new EmbeddedAgentTypeSource(),
        directoryOf({
          origin: EDefinitionOrigin.User,
          files: [
            {
              name: 'quick.md',
              text: definition({ description: 'be quick', model: 'claude-haiku-45' }),
            },
          ],
        }),
      ],
      modelIsUsable: () => false,
    })

    expect(catalog.types.map((agentType) => agentType.name)).not.toContain('quick')
    expect(catalog.refusals[0]?.refusal).toBe(EAgentTypeRefusal.UnusableModel)
    expect(spawnDescription(container)).not.toContain('- quick:')
  })

  it('keeps boot going when a whole directory cannot be read', async () => {
    const container = await harnessContainer()

    const catalog = await bindAgentTypes({
      container,
      sources: [
        new EmbeddedAgentTypeSource(),
        new DirectoryAgentTypeSource({
          directory: AGENTS_DIRECTORY,
          origin: EDefinitionOrigin.Project,
          read: async () => ({
            files: [],
            unreadable: [{ path: AGENTS_DIRECTORY, detail: 'EACCES: permission denied' }],
          }),
        }),
      ],
    })

    expect(catalog.types.map((agentType) => agentType.name)).toContain('explore')
    expect(catalog.refusals[0]?.refusal).toBe(EAgentTypeRefusal.Unreadable)
    expect(spawnableTypes(container).map((agentType) => agentType.name)).toContain('explore')
  })
})

describe('the container with nothing bound over it', () => {
  it('offers the built-ins alone', async () => {
    const container = await harnessContainer()

    expect(spawnableTypes(container).map((agentType) => agentType.name)).toEqual([
      'general-purpose',
      'explore',
      'builder',
      'reviewer',
    ])
  })
})
