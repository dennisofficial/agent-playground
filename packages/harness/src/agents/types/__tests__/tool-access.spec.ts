import { EDefinitionOrigin, EToolEffect, toCallId, toRunId, toThreadId } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { HookChain } from '../../../hooks/registry'
import { HookedToolDispatcher, type DispatchableCall } from '../../../tools/dispatch'
import { InMemoryToolRegistry } from '../../../tools/registry'
import { toolNamed } from '../../../tools/__tests__/fixtures'
import { AGENT_SPAWN_TOOL_NAME, type AgentType } from '../agent-type'
import { EmbeddedAgentTypeSource } from '../embedded-source'
import { loadAgentTypes } from '../registry'
import { toolRegistryFor } from '../tool-access'

const EFFECT_OF: Readonly<Record<string, EToolEffect>> = {
  bash: EToolEffect.Destructive,
  write: EToolEffect.Write,
  edit: EToolEffect.Write,
}

let ran: string[] = []

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
    recording('write'),
    recording('edit'),
    recording('bash'),
    recording(AGENT_SPAWN_TOOL_NAME),
  ])

const builtInTypes = (): Promise<readonly AgentType[]> =>
  loadAgentTypes({ sources: [new EmbeddedAgentTypeSource()] })

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

describe('a dispatcher over a registry narrowed for a built-in agent type', () => {
  it('refuses agent_spawn called by name, so depth caps at one by construction', async () => {
    for (const agentType of await builtInTypes()) {
      const message = await dispatchTo({ agentType, name: AGENT_SPAWN_TOOL_NAME })

      expect(ran).toEqual([])
      expect(message).toContain(AGENT_SPAWN_TOOL_NAME)
    }
  })

  it('still runs every other tool, because a sub-agent has the capabilities of its parent', async () => {
    for (const agentType of await builtInTypes()) {
      for (const name of ['read', 'write', 'bash']) {
        await dispatchTo({ agentType, name })
        expect(ran).toEqual([name])
      }
    }
  })

  it('offers every built-in the whole toolset apart from the spawn tool', async () => {
    for (const agentType of await builtInTypes()) {
      const narrowed = toolRegistryFor({ registry: wholeToolset(), agentType })

      expect(narrowed.declarations().map((declaration) => declaration.name)).toEqual([
        'read',
        'grep',
        'glob',
        'write',
        'edit',
        'bash',
      ])
    }
  })
})

describe('a registry narrowed for a user-authored agent type', () => {
  it('honours an allow list, and still withholds the spawn tool', async () => {
    const narrowed = toolRegistryFor({
      registry: wholeToolset(),
      agentType: {
        name: 'narrow',
        whenToUse: 'a user-authored type that asks for two tools',
        prompt: 'p',
        tools: ['read', 'grep'],
        disallowedTools: [AGENT_SPAWN_TOOL_NAME],
        origin: EDefinitionOrigin.User,
      },
    })

    expect(narrowed.declarations().map((declaration) => declaration.name)).toEqual(['read', 'grep'])
    expect(narrowed.find(AGENT_SPAWN_TOOL_NAME)).toBeUndefined()
  })

  it('withholds a destructive tool its effect ceiling forbids, even when its allow list names it', () => {
    const narrowed = toolRegistryFor({
      registry: wholeToolset(),
      agentType: {
        name: 'capped',
        whenToUse: 'a user-authored type that caps itself at reading',
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
