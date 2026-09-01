import { EDefinitionOrigin } from '@dltech/atlas-core'
import { EAgentTypeRefusal, type AgentType, type AgentTypeCatalog } from '@dltech/atlas-harness'
import { describe, expect, it } from 'bun:test'

import {
  agentTypeCount,
  agentTypeSections,
  catalogIsEmpty,
  EAgentTypeSection,
  refusalLabel,
} from '../agent-types-model'

const EMPTY: AgentTypeCatalog = { types: [], refusals: [], shadowed: [] }

const explore: AgentType = {
  name: 'explore',
  whenToUse: 'sweep the tree for a thing',
  prompt: 'go and look',
  origin: EDefinitionOrigin.BuiltIn,
}

const catalog = (over: Partial<AgentTypeCatalog> = {}): AgentTypeCatalog => ({
  ...EMPTY,
  ...over,
})

const kinds = (given: AgentTypeCatalog) => agentTypeSections(given).map((one) => one.kind)

describe('reading the agent type catalog', () => {
  it('leads with the failures, because a working list is not what the operator came for', () => {
    const built = catalog({
      types: [explore],
      refusals: [
        {
          refusal: EAgentTypeRefusal.NoPrompt,
          name: 'reviewer',
          definedIn: '/home/dev/.atlas/agents/reviewer.md',
          origin: EDefinitionOrigin.User,
          detail: 'nothing follows the front matter',
        },
      ],
      shadowed: [
        {
          name: 'explore',
          origin: EDefinitionOrigin.User,
          definedIn: '/home/dev/.atlas/agents/explore.md',
          shadowedBy: EDefinitionOrigin.Project,
        },
      ],
    })

    expect(kinds(built)).toEqual([
      EAgentTypeSection.Refused,
      EAgentTypeSection.Shadowed,
      EAgentTypeSection.Loaded,
    ])
  })

  it('leaves out a section with nothing in it rather than showing an empty heading', () => {
    expect(kinds(catalog({ types: [explore] }))).toEqual([EAgentTypeSection.Loaded])
    expect(kinds(EMPTY)).toEqual([])
    expect(catalogIsEmpty(EMPTY)).toBe(true)
  })

  it('says why a file was refused and quotes what is wrong with it', () => {
    const [section] = agentTypeSections(
      catalog({
        refusals: [
          {
            refusal: EAgentTypeRefusal.BadName,
            name: 'Reviewer',
            definedIn: '/home/dev/.atlas/agents/Reviewer.md',
            origin: EDefinitionOrigin.User,
            detail: '"Reviewer" cannot name an agent type: it must be lower case',
          },
        ],
      }),
    )
    const row = section?.rows[0]

    expect(row?.name).toBe('Reviewer')
    expect(row?.detail).toContain(refusalLabel(EAgentTypeRefusal.BadName))
    expect(row?.detail).toContain('"Reviewer" cannot name an agent type')
    expect(row?.definedIn).toBe('/home/dev/.atlas/agents/Reviewer.md')
  })

  it('names a refused file the reader can still find when the name never parsed', () => {
    const [section] = agentTypeSections(
      catalog({
        refusals: [
          {
            refusal: EAgentTypeRefusal.Empty,
            name: undefined,
            definedIn: '/home/dev/.atlas/agents/blank.md',
            origin: EDefinitionOrigin.User,
            detail: 'the file has no content',
          },
        ],
      }),
    )

    expect(section?.rows[0]?.name).toBe('unnamed')
    expect(section?.rows[0]?.definedIn).toBe('/home/dev/.atlas/agents/blank.md')
  })

  it('says which definition displaced a shadowed one, not merely that one did', () => {
    const [section] = agentTypeSections(
      catalog({
        shadowed: [
          {
            name: 'explore',
            origin: EDefinitionOrigin.User,
            definedIn: '/home/dev/.atlas/agents/explore.md',
            shadowedBy: EDefinitionOrigin.Project,
          },
        ],
      }),
    )
    const row = section?.rows[0]

    expect(row?.name).toBe('explore')
    expect(row?.detail).toContain('user')
    expect(row?.detail).toContain('project')
    expect(row?.definedIn).toBe('/home/dev/.atlas/agents/explore.md')
  })

  it('folds a description written across lines onto one', () => {
    const [section] = agentTypeSections(
      catalog({ types: [{ ...explore, whenToUse: 'sweep the tree\n  for a thing' }] }),
    )

    expect(section?.rows[0]?.detail).toContain('sweep the tree for a thing')
  })

  it('counts all three so the badge says what was read even when a section is absent', () => {
    expect(agentTypeCount(catalog({ types: [explore] }))).toBe(
      '1 loaded, 0 refused, 0 shadowed',
    )
  })
})
