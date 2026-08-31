import { EDefinitionOrigin, EToolEffect } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { AGENT_SPAWN_TOOL_NAME, type AgentType } from '../agent-type'
import { EmbeddedAgentTypeSource } from '../embedded-source'
import { loadAgentTypes } from '../registry'

const load = (): Promise<readonly AgentType[]> =>
  loadAgentTypes({ sources: [new EmbeddedAgentTypeSource()] })

const named = async (name: string): Promise<AgentType> => {
  const found = (await load()).find((agentType) => agentType.name === name)
  if (found === undefined) throw new Error(`no built-in agent type named ${name}`)
  return found
}

const WRITING_TOOLS = ['write', 'edit']

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

  it('lets general-purpose and builder inherit the whole tool set', async () => {
    expect((await named('general-purpose')).tools).toBeUndefined()
    expect((await named('builder')).tools).toBeUndefined()
  })

  it('caps explore and reviewer at a read effect, so a new tool is withheld by default', async () => {
    for (const name of ['explore', 'reviewer']) {
      expect((await named(name)).maxEffect).toBe(EToolEffect.Read)
    }
  })

  it('withholds every writing tool and the shell from explore and reviewer', async () => {
    for (const name of ['explore', 'reviewer']) {
      const tools = (await named(name)).tools ?? []
      expect(tools).toContain('read')
      expect(tools).toContain('grep')
      expect(tools).toContain('glob')
      for (const writing of WRITING_TOOLS) expect(tools).not.toContain(writing)
      expect(tools).not.toContain('bash')
    }
  })

  it('lets general-purpose and builder keep a destructive tool by leaving the ceiling off', async () => {
    expect((await named('general-purpose')).maxEffect).toBeUndefined()
    expect((await named('builder')).maxEffect).toBeUndefined()
  })

  it('tells every built-in that only its final message reaches the caller', async () => {
    for (const agentType of await load()) {
      expect(agentType.prompt).toContain('Only your final message reaches the caller')
      expect(agentType.prompt).toContain('Do not gold-plate')
      expect(agentType.prompt).toContain('Do not leave it half-done')
    }
  })

  it('tells the read-only built-ins they have no shell, matching what they are given', async () => {
    for (const name of ['explore', 'reviewer']) {
      const agentType = await named(name)
      expect(agentType.prompt).toContain('You have no shell')
      expect(agentType.whenToUse).toContain('no shell')
    }
  })
})
