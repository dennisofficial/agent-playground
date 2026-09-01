import { EDefinitionOrigin } from '@dltech/atlas-core'
import { EAgentTypeRefusal, type AgentTypeCatalog } from '@dltech/atlas-harness'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { NOTHING_ON_DISK } from '../agent-types-model'
import { AgentTypes } from '../components/agent-types'
import { frameOf } from './transcript-fixture'

const WIDE = 110

const REVIEWER_PATH = '/work/project/.atlas/agents/reviewer.md'

const EXPLORE_PATH = '/work/project/.atlas/agents/explore.md'

const BAD_NAME_DETAIL = '"Reviewer" cannot name an agent type: it must be lower case'

const EMPTY_CATALOG: AgentTypeCatalog = { types: [], refusals: [], shadowed: [] }

const FED: AgentTypeCatalog = {
  types: [
    {
      name: 'explore',
      whenToUse: 'sweep the tree for a thing',
      prompt: 'go and look',
      origin: EDefinitionOrigin.BuiltIn,
    },
  ],
  refusals: [
    {
      refusal: EAgentTypeRefusal.BadName,
      name: 'Reviewer',
      definedIn: REVIEWER_PATH,
      origin: EDefinitionOrigin.Project,
      detail: BAD_NAME_DETAIL,
    },
  ],
  shadowed: [
    {
      name: 'explore',
      origin: EDefinitionOrigin.User,
      definedIn: EXPLORE_PATH,
      shadowedBy: EDefinitionOrigin.Project,
    },
  ],
}

const framed = (catalog: AgentTypeCatalog, width = WIDE): Promise<string> =>
  frameOf(<AgentTypes width={width} catalog={catalog} />, width)

describe('the agent types panel', () => {
  it('renders a refusal with the reason and the value that caused it', async () => {
    const frame = await framed(FED)

    expect(frame).toContain('NOT LOADED')
    expect(frame).toContain('Reviewer')
    expect(frame).toContain('cannot name an agent type')
  })

  it('renders a shadowed type with what displaced it', async () => {
    const frame = await framed(FED)

    expect(frame).toContain('SHADOWED')
    expect(frame).toContain('project')
    expect(frame).toContain('unused')
  })

  it('names the file for a refusal, because that is the thing to go and open', async () => {
    const frame = await framed(FED)

    expect(frame).toContain('reviewer.md')
  })

  it('keeps the file readable at the narrow end rather than eliding it to nothing', async () => {
    const frame = await framed(FED, 60)

    expect(frame).toContain('reviewer.md')
  })

  it('lists what did load, under its own heading', async () => {
    const frame = await framed(FED)

    expect(frame).toContain('LOADED')
    expect(frame).toContain('explore')
    expect(frame).toContain('sweep the tree for a thing')
  })

  it('counts all three in the badge, so an absent section is still accounted for', async () => {
    expect(await framed(FED)).toContain('1 loaded, 1 refused, 1 shadowed')
  })

  it('shows no heading for a kind it has nothing of', async () => {
    const frame = await framed({ ...EMPTY_CATALOG, types: FED.types })

    expect(frame).toContain('sweep the tree for a thing')
    expect(frame).not.toContain('NOT LOADED')
    expect(frame).not.toContain('SHADOWED')
    expect(frame).not.toContain('Reviewer')
  })

  it('says where to write one when the operator has none at all', async () => {
    const frame = await framed(EMPTY_CATALOG)

    expect(frame).toContain(NOTHING_ON_DISK.slice(0, 40))
  })
})
