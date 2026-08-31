import { EDefinitionOrigin } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { AGENT_SPAWN_TOOL_NAME, AgentTypeSource, type AgentType } from '../agent-type'
import { DirectoryAgentTypeSource } from '../directory-source'
import { loadAgentTypes } from '../registry'

class FakeAgentTypeSource extends AgentTypeSource {
  readonly origin: EDefinitionOrigin
  private readonly files: readonly { name: string; text: string }[]

  constructor(args: {
    origin: EDefinitionOrigin
    files: readonly { name: string; text: string }[]
  }) {
    super()
    this.origin = args.origin
    this.files = args.files
  }

  load(): Promise<readonly AgentType[]> {
    return new DirectoryAgentTypeSource({
      directory: this.origin,
      origin: this.origin,
      read: async () => this.files,
    }).load()
  }
}

const sourceOf = (args: {
  origin: EDefinitionOrigin
  files: readonly { name: string; text: string }[]
}): AgentTypeSource => new FakeAgentTypeSource(args)

const definition = (args: { description?: string; tools?: string; body?: string }): string =>
  [
    '---',
    `description: ${args.description ?? 'do things'}`,
    ...(args.tools === undefined ? [] : [`tools: ${args.tools}`]),
    '---',
    args.body ?? 'Prompt.',
  ].join('\n')

describe('loadAgentTypes', () => {
  it('merges every source when no name collides', async () => {
    const loaded = await loadAgentTypes({
      sources: [
        sourceOf({
          origin: EDefinitionOrigin.BuiltIn,
          files: [{ name: 'builder.md', text: definition({}) }],
        }),
        sourceOf({
          origin: EDefinitionOrigin.User,
          files: [{ name: 'auditor.md', text: definition({}) }],
        }),
        sourceOf({
          origin: EDefinitionOrigin.Project,
          files: [{ name: 'migrator.md', text: definition({}) }],
        }),
      ],
    })

    expect(loaded.map((agentType) => agentType.name)).toEqual(['auditor', 'builder', 'migrator'])
  })

  it('lets a project file shadow a user file shadow a built-in', async () => {
    const file = (body: string) => [{ name: 'reviewer.md', text: definition({ body }) }]

    const loaded = await loadAgentTypes({
      sources: [
        sourceOf({ origin: EDefinitionOrigin.Project, files: file('project prompt') }),
        sourceOf({ origin: EDefinitionOrigin.BuiltIn, files: file('built-in prompt') }),
        sourceOf({ origin: EDefinitionOrigin.User, files: file('user prompt') }),
      ],
    })

    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.origin).toBe(EDefinitionOrigin.Project)
    expect(loaded[0]?.prompt).toBe('project prompt')
  })

  it('lets a user file shadow a built-in when no project file claims the name', async () => {
    const file = (body: string) => [{ name: 'reviewer.md', text: definition({ body }) }]

    const loaded = await loadAgentTypes({
      sources: [
        sourceOf({ origin: EDefinitionOrigin.BuiltIn, files: file('built-in prompt') }),
        sourceOf({ origin: EDefinitionOrigin.User, files: file('user prompt') }),
      ],
    })

    expect(loaded[0]?.origin).toBe(EDefinitionOrigin.User)
    expect(loaded[0]?.prompt).toBe('user prompt')
  })

  it('never grants agent_spawn, however a definition asks for it', async () => {
    const loaded = await loadAgentTypes({
      sources: [
        sourceOf({
          origin: EDefinitionOrigin.Project,
          files: [
            { name: 'recursive.md', text: definition({ tools: `read, ${AGENT_SPAWN_TOOL_NAME}` }) },
          ],
        }),
      ],
    })

    expect(loaded[0]?.tools).toEqual(['read'])
    expect(loaded[0]?.disallowedTools).toEqual([AGENT_SPAWN_TOOL_NAME])
  })

  it('denies agent_spawn to an agent type that inherits every tool', async () => {
    const loaded = await loadAgentTypes({
      sources: [
        sourceOf({
          origin: EDefinitionOrigin.Project,
          files: [{ name: 'wide.md', text: definition({ tools: '*' }) }],
        }),
      ],
    })

    expect(loaded[0]?.tools).toBeUndefined()
    expect(loaded[0]?.disallowedTools).toEqual([AGENT_SPAWN_TOOL_NAME])
  })

  it('leaves an agent type asking only for agent_spawn with no tools at all', async () => {
    const loaded = await loadAgentTypes({
      sources: [
        sourceOf({
          origin: EDefinitionOrigin.Project,
          files: [{ name: 'greedy.md', text: definition({ tools: AGENT_SPAWN_TOOL_NAME }) }],
        }),
      ],
    })

    expect(loaded[0]?.tools).toEqual([])
  })

  it('keeps a declared denial alongside the agent_spawn denial, without duplicating it', async () => {
    const text = [
      '---',
      'description: do things',
      `disallowed-tools: write, ${AGENT_SPAWN_TOOL_NAME}`,
      '---',
      'Prompt.',
    ].join('\n')

    const loaded = await loadAgentTypes({
      sources: [sourceOf({ origin: EDefinitionOrigin.User, files: [{ name: 'safe.md', text }] })],
    })

    expect(loaded[0]?.disallowedTools).toEqual(['write', AGENT_SPAWN_TOOL_NAME])
  })

  it('yields nothing when no source has anything to offer', async () => {
    expect(await loadAgentTypes({ sources: [] })).toEqual([])
  })
})
