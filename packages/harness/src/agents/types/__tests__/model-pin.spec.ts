import { EDefinitionOrigin, EFinishReason, type ModelPort } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import {
  AgentTypeSource,
  EAgentTypeRefusal,
  type AgentType,
  type AgentTypeRead,
} from '../agent-type'
import { pinnedModelSource } from '../pinned-model'
import { loadAgentTypes } from '../registry'

const REACHABLE = 'claude-haiku-4-5'
const STAMPED = 'claude-haiku-4-5-20251001'
const ANOTHER_VENDOR = 'gpt-5-codex'
const TYPO = 'claude-haiku-45'

class FileSource extends AgentTypeSource {
  readonly origin = EDefinitionOrigin.User
  private readonly types: readonly AgentType[]

  constructor(args: { types: readonly AgentType[] }) {
    super()
    this.types = args.types
  }

  async load(): Promise<AgentTypeRead> {
    return { types: this.types, refusals: [] }
  }
}

const typeOf = (args: { name: string; model?: string | undefined }): AgentType => ({
  name: args.name,
  whenToUse: 'do things',
  prompt: 'Prompt.',
  origin: EDefinitionOrigin.User,
  definedIn: `/h/.atlas/agents/${args.name}.md`,
  ...(args.model === undefined ? {} : { model: args.model }),
})

const load = (types: readonly AgentType[], modelIsUsable?: (modelId: string) => boolean) =>
  loadAgentTypes({
    sources: [new FileSource({ types })],
    ...(modelIsUsable === undefined ? {} : { modelIsUsable }),
  })

const port = (modelId: string): ModelPort => ({
  identity: { id: 'fixture', modelId },
  step: async () => ({ parts: [], toolCalls: [], finishReason: EFinishReason.Stop }),
})

describe('a model pinned by an agent type file', () => {
  it('is kept when the catalogue knows it, release stamp and all', async () => {
    const { types, refusals } = await load([
      typeOf({ name: 'quick', model: STAMPED }),
      typeOf({ name: 'plain', model: REACHABLE }),
    ])

    expect(refusals).toEqual([])
    expect(types.map((agentType) => agentType.model)).toEqual([REACHABLE, STAMPED])
  })

  it('is refused when it names no model at all, rather than running on the parent silently', async () => {
    const { types, refusals } = await load([typeOf({ name: 'quick', model: TYPO })])

    expect(types).toEqual([])
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.refusal).toBe(EAgentTypeRefusal.UnusableModel)
    expect(refusals[0]?.name).toBe('quick')
    expect(refusals[0]?.definedIn).toBe('/h/.atlas/agents/quick.md')
    expect(refusals[0]?.detail).toContain(`"${TYPO}"`)
  })

  it('names the models that could have been pinned instead', async () => {
    const { refusals } = await load([typeOf({ name: 'quick', model: TYPO })])

    expect(refusals[0]?.detail).toContain(REACHABLE)
  })

  it('is refused when the composition root cannot reach that vendor', async () => {
    const anthropicOnly = (modelId: string) => modelId !== ANOTHER_VENDOR

    const { types, refusals } = await load(
      [typeOf({ name: 'codex', model: ANOTHER_VENDOR })],
      anthropicOnly,
    )

    expect(types).toEqual([])
    expect(refusals[0]?.refusal).toBe(EAgentTypeRefusal.UnusableModel)
    expect(refusals[0]?.detail).not.toContain(ANOTHER_VENDOR.concat(','))
  })

  it('takes the whole agent type with it, the way a bad max-effect does', async () => {
    const { types } = await load([
      typeOf({ name: 'quick', model: TYPO }),
      typeOf({ name: 'sound' }),
    ])

    expect(types.map((agentType) => agentType.name)).toEqual(['sound'])
  })

  it('lets a sound definition of the same name win once the bad one is out', async () => {
    const { types } = await loadAgentTypes({
      sources: [
        new FileSource({
          types: [
            { ...typeOf({ name: 'quick' }), origin: EDefinitionOrigin.BuiltIn },
            typeOf({ name: 'quick', model: TYPO }),
          ],
        }),
      ],
    })

    expect(types).toHaveLength(1)
    expect(types[0]?.origin).toBe(EDefinitionOrigin.BuiltIn)
  })
})

describe('the model a child is actually run against', () => {
  it('is the parent selection when the type pins nothing', () => {
    const inherited = port('claude-opus-5')
    const modelFor = pinnedModelSource({
      inherited: () => inherited,
      build: () => {
        throw new Error('nothing should have been built')
      },
    })

    expect(modelFor({ agentType: typeOf({ name: 'plain' }) })).toBe(inherited)
  })

  it('is built from the pinned id when the type names one', () => {
    const asked: string[] = []
    const modelFor = pinnedModelSource({
      inherited: () => port('claude-opus-5'),
      build: ({ modelId }) => {
        asked.push(modelId)
        return port(modelId)
      },
    })

    const built = modelFor({ agentType: typeOf({ name: 'quick', model: STAMPED }) })

    expect(asked).toEqual([STAMPED])
    expect(built.identity.modelId).toBe(STAMPED)
  })

  it('is rebuilt per spawn, so a child started after a switch reads the current selection', () => {
    let effort = 'low'
    const modelFor = pinnedModelSource({
      inherited: () => port('claude-opus-5'),
      build: ({ modelId }) => port(`${modelId}:${effort}`),
    })

    const first = modelFor({ agentType: typeOf({ name: 'quick', model: REACHABLE }) })
    effort = 'high'
    const second = modelFor({ agentType: typeOf({ name: 'quick', model: REACHABLE }) })

    expect(first.identity.modelId).toBe(`${REACHABLE}:low`)
    expect(second.identity.modelId).toBe(`${REACHABLE}:high`)
  })
})
