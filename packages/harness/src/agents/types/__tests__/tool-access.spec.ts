import { EDefinitionOrigin, EToolEffect, toCallId, toRunId, toThreadId } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { HookChain } from '../../../hooks/registry'
import { HookedToolDispatcher, type DispatchableCall } from '../../../tools/dispatch'
import { InMemoryToolRegistry } from '../../../tools/registry'
import { toolNamed } from '../../../tools/__tests__/fixtures'
import type { AgentType } from '../agent-type'
import { EmbeddedAgentTypeSource } from '../embedded-source'
import { loadAgentTypes } from '../registry'
import { toolRegistryFor } from '../tool-access'

let ran: string[] = []

const EFFECT_OF: Readonly<Record<string, EToolEffect>> = {
  bash: EToolEffect.Destructive,
  shell_kill: EToolEffect.Destructive,
  write: EToolEffect.Write,
  edit: EToolEffect.Write,
}

const recording = (name: string) =>
  toolNamed({
    name,
    effect: EFFECT_OF[name] ?? EToolEffect.Read,
    invoke: async () => {
      ran.push(name)
      return { ok: true as const, output: '', modelText: 'rendered' }
    },
  })

const wholeToolset = () =>
  new InMemoryToolRegistry([
    recording('read'),
    recording('grep'),
    recording('glob'),
    recording('shell_list'),
    recording('shell_output'),
    recording('write'),
    recording('edit'),
    recording('bash'),
    recording('agent_spawn'),
  ])

const builtIn = async (name: string): Promise<AgentType> => {
  const loaded = await loadAgentTypes({ sources: [new EmbeddedAgentTypeSource()] })
  const found = loaded.find((agentType) => agentType.name === name)
  if (found === undefined) throw new Error(`no built-in agent type named ${name}`)
  return found
}

const callOf = (name: string): DispatchableCall => ({
  callId: toCallId('call-1'),
  name,
  input: { path: 'a.ts' },
  runId: toRunId('run-1'),
  threadId: toThreadId('thread-1'),
})

const dispatchTo = async (args: { agentType: AgentType; name: string }): Promise<string> => {
  ran = []
  const dispatcher = new HookedToolDispatcher({
    registry: toolRegistryFor({ registry: wholeToolset(), agentType: args.agentType }),
    hooks: new HookChain({}),
  })

  const drafts = await dispatcher.dispatch({
    call: callOf(args.name),
    signal: new AbortController().signal,
    sessionDirectory: '/workspace',
  })

  const draft = drafts[0]
  return draft?.type === 'tool-result' ? (draft.error?.message ?? '') : ''
}

describe('a dispatcher over a reviewer-narrowed registry', () => {
  it('refuses bash called by name, so read-only is a capability and not a promise', async () => {
    const message = await dispatchTo({ agentType: await builtIn('reviewer'), name: 'bash' })

    expect(ran).toEqual([])
    expect(message).toContain('bash')
  })

  it('refuses every writing and destructive tool called by name', async () => {
    const reviewer = await builtIn('reviewer')

    for (const name of ['write', 'edit', 'bash', 'shell_kill', 'agent_spawn']) {
      await dispatchTo({ agentType: reviewer, name })
      expect(ran).toEqual([])
    }
  })

  it('still runs the reading tools it was given', async () => {
    await dispatchTo({ agentType: await builtIn('reviewer'), name: 'read' })

    expect(ran).toEqual(['read'])
  })
})

describe('a registry narrowed for a built-in agent type', () => {
  it('offers explore only reading tools, and no shell', async () => {
    const narrowed = toolRegistryFor({
      registry: wholeToolset(),
      agentType: await builtIn('explore'),
    })

    expect(narrowed.declarations().map((declaration) => declaration.name)).toEqual([
      'read',
      'grep',
      'glob',
      'shell_list',
      'shell_output',
    ])
    expect(narrowed.find('bash')).toBeUndefined()
  })

  it('offers builder the whole toolset except the spawn tool', async () => {
    const narrowed = toolRegistryFor({
      registry: wholeToolset(),
      agentType: await builtIn('builder'),
    })

    expect(narrowed.find('bash')).toBeDefined()
    expect(narrowed.find('write')).toBeDefined()
    expect(narrowed.find('agent_spawn')).toBeUndefined()
  })

  it('withholds a destructive tool the agent type explicitly allowed but its ceiling forbids', () => {
    const narrowed = toolRegistryFor({
      registry: wholeToolset(),
      agentType: {
        name: 'sneaky',
        whenToUse: 'claims to be read-only',
        prompt: 'p',
        tools: ['read', 'bash'],
        maxEffect: EToolEffect.Read,
        origin: EDefinitionOrigin.Project,
      },
    })

    expect(narrowed.find('read')).toBeDefined()
    expect(narrowed.find('bash')).toBeUndefined()
  })
})
