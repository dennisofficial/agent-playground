import { afterEach, describe, expect, it } from 'bun:test'
import type { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'

import {
  defaultPipeline,
  EMPTY_PROMPT,
  EToolEffect,
  PromptFragment,
  type ThreadId,
  type ToolDefinition,
  type ToolOutcome,
} from '@dltech/atlas-core'

import { HookChain } from '../../../hooks/registry'
import { buildHarness, type AtlasHarness } from '../../../loop/build-harness'
import { createTempDatabase, type TempDatabase } from '../../../loop/__tests__/temp-database'
import { scriptedModel, type ScriptedStep } from '../../../model/testing/scripted-model'
import { AtlasIdentityFragment } from '../../../prompt/fragments/identity'
import { InMemoryPromptRegistry } from '../../../prompt/registry'
import { InMemoryToolRegistry } from '../../../tools/registry'
import { AGENT_TOOL_NAMES, toolRegistryFor, type AgentType } from '../../types'
import { childRunnerSource } from '../child-runner'
import { subAgentPrompt } from '../child-prompt'
import { AgentSupervisor } from '../supervisor'
import { agentTypeNamed, fixedModelPort } from './fixtures'

const PROJECT_DIRECTORY = '/w'

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

const invoked: string[] = []

function toolNamed(name: string): ToolDefinition {
  return {
    name,
    description: `the ${name} tool`,
    effect: EToolEffect.Read,
    inputSchema: z.object({}),
    invoke: (): Promise<ToolOutcome> => {
      invoked.push(name)
      return Promise.resolve({ ok: true, output: {}, modelText: `${name} ran` })
    },
  }
}

class SharedFragment extends PromptFragment {
  readonly id = 'shared.everywhere'

  text(): string {
    return 'Every agent reads this.'
  }
}

type Spawned = {
  harness: AtlasHarness
  model: MockLanguageModelV4
  supervisor: AgentSupervisor
  parent: ThreadId
  agentId: ThreadId
}

async function spawn(args: {
  script: readonly ScriptedStep[]
  agentType: AgentType
  tools?: readonly ToolDefinition[]
  pinned?: string | undefined
}): Promise<Spawned> {
  const pinned = args.pinned
  const temp = createTempDatabase()
  const model = scriptedModel({ script: args.script })
  const harness = await buildHarness({ databaseUrl: temp.databaseUrl, model })
  opened.push({ harness, temp })

  const prompts = new InMemoryPromptRegistry([new AtlasIdentityFragment(), new SharedFragment()])
  const tools = new InMemoryToolRegistry(args.tools ?? [])

  const supervisor = new AgentSupervisor({
    log: harness.log,
    threads: harness.threads,
    ids: harness.ids,
    clock: harness.clock,
    agentTypes: [args.agentType],
    runners: childRunnerSource({
      deps: () => ({
        turn: {
          log: harness.log,
          model: harness.model,
          ids: harness.ids,
          assembly: defaultPipeline({
            prompt: () => EMPTY_PROMPT,
            projectDirectory: PROJECT_DIRECTORY,
          }),
          projectDirectory: PROJECT_DIRECTORY,
        },
        tools,
        hooks: new HookChain({}),
        assemblyFor: ({ agentType }) =>
          defaultPipeline({
            prompt: () => subAgentPrompt({ prompts, agentType, provider: harness.model.identity }),
            projectDirectory: PROJECT_DIRECTORY,
          }),
        ...(pinned === undefined
          ? {}
          : { modelFor: () => fixedModelPort({ modelId: pinned, text: 'the pinned model' }) }),
      }),
    }),
  })

  const parent = (await harness.threads.create({})).id
  const ended = new Promise<void>((resolve) => {
    const forget = supervisor.onNotice(() => {
      forget()
      resolve()
    })
  })

  const outcome = await supervisor.spawn({
    threadId: parent,
    agentType: args.agentType.name,
    brief: 'count the call sites of assemble',
    intent: 'count assemble callers',
  })
  if (!outcome.ok) throw new Error(outcome.reason)
  await ended

  return { harness, model, supervisor, parent, agentId: outcome.snapshot.agentId }
}

afterEach(async () => {
  invoked.splice(0)
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
})

describe('a child taking its first step', () => {
  it('answers the brief it was seeded with', async () => {
    const spawned = await spawn({
      script: [{ text: 'four call sites' }],
      agentType: agentTypeNamed({ name: 'explore' }),
    })

    const events = await spawned.harness.log.read({ threadId: spawned.agentId })
    expect(events.map((event) => event.type)).toEqual(['user-said', 'assistant-said'])
    expect(spawned.model.doStreamCalls[0]?.prompt.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'count the call sites of assemble' }],
    })
  })

  it('reports what it said and what it did back to the parent', async () => {
    const spawned = await spawn({
      script: [{ text: 'four call sites' }],
      agentType: agentTypeNamed({ name: 'explore' }),
    })

    const [draft] = spawned.supervisor.drainNotifications({ threadId: spawned.parent })
    expect(draft?.type === 'agent-ended' ? draft.prose : '').toBe('four call sites')
    expect(draft?.type === 'agent-ended' ? draft.turns : 0).toBe(1)
  })
})

describe("a child's tools", () => {
  it('refuses agent_spawn by name for a type built in code, which the loader never saw', async () => {
    const agentType = agentTypeNamed({ name: 'builder' })
    expect(agentType.disallowedTools).toBeUndefined()
    expect(
      toolRegistryFor({
        registry: new InMemoryToolRegistry([toolNamed('agent_spawn')]),
        agentType,
      }).find('agent_spawn'),
    ).toBeDefined()

    const spawned = await spawn({
      script: [
        { calls: [{ callId: 'call_spawn', name: 'agent_spawn', input: {} }] },
        { text: 'I cannot spawn' },
      ],
      agentType,
      tools: [toolNamed('agent_spawn'), toolNamed('read')],
    })

    const events = await spawned.harness.log.read({ threadId: spawned.agentId })
    const results = events.filter((event) => event.type === 'tool-result')
    expect(results).toHaveLength(1)
    expect(results[0]?.type === 'tool-result' ? results[0].error?.message : '').toMatch(
      /no tool named "agent_spawn" is registered/,
    )
    expect(invoked).toEqual([])
  })

  it("is handed none of the sub-agent tools, which are the parent's instruments", async () => {
    const spawned = await spawn({
      script: [{ text: 'nothing to do' }],
      agentType: agentTypeNamed({ name: 'builder' }),
      tools: [...AGENT_TOOL_NAMES.map(toolNamed), toolNamed('read')],
    })

    expect(AGENT_TOOL_NAMES).toEqual([
      'agent_spawn',
      'agent_say',
      'agent_resume',
      'agent_list',
      'agent_stop',
    ])
    expect(spawned.model.doStreamCalls[0]?.tools?.map((tool) => tool.name)).toEqual(['read'])
  })

  it('refuses every sub-agent tool by name, not only agent_spawn', async () => {
    const spawned = await spawn({
      script: [
        { calls: AGENT_TOOL_NAMES.map((name) => ({ callId: `call_${name}`, name, input: {} })) },
        { text: 'I have none of those' },
      ],
      agentType: agentTypeNamed({ name: 'builder' }),
      tools: [...AGENT_TOOL_NAMES.map(toolNamed), toolNamed('read')],
    })

    const events = await spawned.harness.log.read({ threadId: spawned.agentId })
    const results = events.filter((event) => event.type === 'tool-result')
    expect(results).toHaveLength(AGENT_TOOL_NAMES.length)
    for (const result of results) {
      expect(result.type === 'tool-result' ? result.error?.message : '').toMatch(
        /no tool named "agent_\w+" is registered/,
      )
    }
    expect(invoked).toEqual([])
  })

  it('is otherwise the whole set, narrowed by the type and by nothing else', async () => {
    const spawned = await spawn({
      script: [{ text: 'nothing to do' }],
      agentType: agentTypeNamed({ name: 'builder' }),
      tools: [toolNamed('agent_spawn'), toolNamed('read'), toolNamed('write')],
    })

    expect(spawned.model.doStreamCalls[0]?.tools?.map((tool) => tool.name)).toEqual([
      'read',
      'write',
    ])
  })

  it('honours the allow-list its type declares', async () => {
    const spawned = await spawn({
      script: [{ text: 'nothing to do' }],
      agentType: agentTypeNamed({ name: 'explore', tools: ['read'] }),
      tools: [toolNamed('agent_spawn'), toolNamed('read'), toolNamed('write')],
    })

    expect(spawned.model.doStreamCalls[0]?.tools?.map((tool) => tool.name)).toEqual(['read'])
  })
})

describe("a child's prompt", () => {
  it("carries its type's prose in place of the main identity", async () => {
    const spawned = await spawn({
      script: [{ text: 'four call sites' }],
      agentType: agentTypeNamed({ name: 'explore' }),
    })

    const system = spawned.model.doStreamCalls[0]?.prompt[0]
    expect(system?.role).toBe('system')
    expect(system?.role === 'system' ? system.content : '').toBe(
      ['You are the explore sub-agent.', 'Every agent reads this.'].join('\n\n'),
    )
  })
})

describe('a type that pins its own model', () => {
  it('runs the child against that model rather than the parent selection', async () => {
    const spawned = await spawn({
      script: [{ text: 'the parent model would have said this' }],
      agentType: agentTypeNamed({ name: 'explore', model: 'claude-haiku-4-5-20251001' }),
      pinned: 'claude-haiku-4-5-20251001',
    })

    const events = await spawned.harness.log.read({ threadId: spawned.agentId })
    const last = events.at(-1)
    expect(last?.type === 'assistant-said' ? last.parts : []).toEqual([
      { type: 'text', text: 'the pinned model' },
    ])
    expect(spawned.model.doStreamCalls).toHaveLength(0)
  })
})
