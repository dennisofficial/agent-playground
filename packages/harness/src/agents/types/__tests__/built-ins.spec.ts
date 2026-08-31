import { EDefinitionOrigin } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { AGENT_SPAWN_TOOL_NAME, type AgentType } from '../agent-type'
import { EmbeddedAgentTypeSource } from '../embedded-source'
import { loadAgentTypes } from '../registry'

const load = async (): Promise<readonly AgentType[]> =>
  (await loadAgentTypes({ sources: [new EmbeddedAgentTypeSource()] })).types

const named = async (name: string): Promise<AgentType> => {
  const found = (await load()).find((agentType) => agentType.name === name)
  if (found === undefined) throw new Error(`no built-in agent type named ${name}`)
  return found
}

const CAPABILITY_CLAIMS = [
  'read-only',
  'no shell',
  'cannot change',
  'changes nothing',
  'withheld',
  'you have no tool',
  'full tool set',
]

describe('the built-in agent types', () => {
  it('ships general-purpose, explore, builder and reviewer, all marked built-in', async () => {
    const loaded = await load()

    expect(loaded.map((agentType) => agentType.name)).toEqual([
      'builder',
      'explore',
      'general-purpose',
      'reviewer',
    ])
    for (const agentType of loaded) {
      expect(agentType.origin).toBe(EDefinitionOrigin.BuiltIn)
    }
  })

  it('pins no model, so a child inherits the parent until model reachability is multi-vendor', async () => {
    for (const agentType of await load()) {
      expect(agentType.model).toBeUndefined()
    }
  })

  it('gives every built-in a whenToUse the model can choose on, and a prompt', async () => {
    for (const agentType of await load()) {
      expect(agentType.whenToUse.length).toBeGreaterThan(40)
      expect(agentType.prompt.length).toBeGreaterThan(40)
    }
  })

  it('denies agent_spawn to every built-in, so a child cannot spawn its own children', async () => {
    for (const agentType of await load()) {
      expect(agentType.disallowedTools).toContain(AGENT_SPAWN_TOOL_NAME)
      expect(agentType.tools ?? []).not.toContain(AGENT_SPAWN_TOOL_NAME)
    }
  })

  it('narrows no built-in, so every one has the capabilities of the agent that spawned it', async () => {
    for (const agentType of await load()) {
      expect(agentType.tools).toBeUndefined()
      expect(agentType.maxEffect).toBeUndefined()
    }
  })

  it('denies nothing but the spawn tool', async () => {
    for (const agentType of await load()) {
      expect(agentType.disallowedTools).toEqual([AGENT_SPAWN_TOOL_NAME])
    }
  })

  it('tells every built-in that only its final message reaches the caller', async () => {
    for (const agentType of await load()) {
      expect(agentType.prompt).toContain('Only your final message reaches the caller')
      expect(agentType.prompt).toContain('Do not gold-plate')
      expect(agentType.prompt).toContain('Do not leave it half-done')
    }
  })

  it('claims no capability limit the mechanism does not enforce, in prompt or in whenToUse', async () => {
    for (const agentType of await load()) {
      const prose = `${agentType.prompt} ${agentType.whenToUse}`.toLowerCase()
      for (const claim of CAPABILITY_CLAIMS) expect(prose).not.toContain(claim)
    }
  })

  it('tells explore and reviewer to report rather than change, as an instruction not a limit', async () => {
    for (const name of ['explore', 'reviewer']) {
      const agentType = await named(name)
      expect(agentType.prompt).toContain('Do not use them to change anything')
      expect(agentType.whenToUse).toContain('briefed to report')
    }
  })
})
