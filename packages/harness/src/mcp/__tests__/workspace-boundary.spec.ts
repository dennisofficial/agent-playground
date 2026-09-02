import { describe, expect, it } from 'bun:test'
import { z } from 'zod'

import {
  BeforeToolHook,
  DynamicToolSource,
  EBeforeToolDecision,
  EToolEffect,
  orderHooks,
  toCallId,
  toThreadId,
  type BeforeToolOutcome,
  type ToolCall,
  type ToolDefinition,
} from '@dltech/atlas-core'

import { createIsolatedContainer, portToken } from '../../container/injection'
import { FileReadStatePort } from '../../files/read-state'
import { ReadBeforeWriteHook } from '../../hooks/read-before-write'
import { ResolveProjectPathsHook } from '../../hooks/resolve-project-paths'
import { InMemoryToolRegistry, ToolRegistry } from '../../tools/registry'
import {
  createWorkspaceBoundaryHook,
  McpHandleTrust,
  WorkspaceBoundaryHook,
} from '../registry/workspace-boundary-hook'

class FixedTrust extends McpHandleTrust {
  constructor(private readonly granted: boolean) {
    super()
  }

  trusted(): boolean {
    return this.granted
  }
}

class FakeSource extends DynamicToolSource {
  constructor(private readonly held: ToolDefinition[]) {
    super()
  }

  declarations() {
    return this.held
  }

  find(name: string) {
    return this.held.find((tool) => tool.name === name)
  }
}

class NoViewState extends FileReadStatePort {
  record(): void {}
  viewOf() {
    return undefined
  }
}

const definition = (name: string, effect: EToolEffect): ToolDefinition => ({
  name,
  description: `the ${name} tool`,
  effect,
  inputSchema: z.object({}),
  invoke: async () => ({ ok: true, output: name, modelText: `${name} ran` }),
})

const callOf = (args: { name: string; effect: EToolEffect; input?: unknown }): ToolCall => ({
  callId: toCallId('call-1'),
  name: args.name,
  input: args.input ?? {},
  effect: args.effect,
  threadId: toThreadId('thread-1'),
})

const hookFor = (args: {
  defs?: readonly ToolDefinition[]
  sources?: readonly DynamicToolSource[]
  trust?: McpHandleTrust
}): WorkspaceBoundaryHook =>
  new WorkspaceBoundaryHook({
    tools: new InMemoryToolRegistry(args.defs ?? []),
    sources: args.sources ?? [],
    trust: args.trust ?? new FixedTrust(false),
  })

const decide = (
  args: { hook: BeforeToolHook; call: ToolCall },
): Promise<BeforeToolOutcome> =>
  args.hook.run({
    call: args.call,
    projectDirectory: '/repo',
    events: [],
    signal: new AbortController().signal,
  })

describe('WorkspaceBoundaryHook', () => {
  it('asks before an untrusted MCP write tool changes the workspace', async () => {
    const hook = hookFor({ defs: [definition('mcp__fs__write', EToolEffect.Write)] })
    const outcome = await decide({
      hook,
      call: callOf({ name: 'mcp__fs__write', effect: EToolEffect.Write }),
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Ask)
    expect(outcome.decision === EBeforeToolDecision.Ask && outcome.reason).toContain('mcp__fs__write')
  })

  it('asks before an untrusted MCP destructive tool', async () => {
    const hook = hookFor({ defs: [definition('mcp__db__drop', EToolEffect.Destructive)] })
    const outcome = await decide({
      hook,
      call: callOf({ name: 'mcp__db__drop', effect: EToolEffect.Destructive }),
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Ask)
    expect(outcome.decision === EBeforeToolDecision.Ask && outcome.reason).toContain('mcp__db__drop')
  })

  it('lets a trusted MCP write tool straight through', async () => {
    const hook = hookFor({
      defs: [definition('mcp__fs__write', EToolEffect.Write)],
      trust: new FixedTrust(true),
    })
    const outcome = await decide({
      hook,
      call: callOf({ name: 'mcp__fs__write', effect: EToolEffect.Write, input: { path: 'a' } }),
    })

    expect(outcome).toEqual({ decision: EBeforeToolDecision.Allow, input: { path: 'a' } })
  })

  it('lets an MCP read tool through even when the server is untrusted', async () => {
    const hook = hookFor({ defs: [definition('mcp__fs__read', EToolEffect.Read)] })
    const outcome = await decide({
      hook,
      call: callOf({ name: 'mcp__fs__read', effect: EToolEffect.Read }),
    })

    expect(outcome).toEqual({ decision: EBeforeToolDecision.Allow, input: {} })
  })

  it('has no opinion on a tool that is not MCP', async () => {
    const hook = hookFor({ defs: [definition('write', EToolEffect.Write)] })
    const outcome = await decide({
      hook,
      call: callOf({ name: 'write', effect: EToolEffect.Write }),
    })

    expect(outcome).toEqual({ decision: EBeforeToolDecision.Allow, input: {} })
  })

  it('recognizes an MCP tool that a dynamic source declares without the mcp__ prefix', async () => {
    const hook = hookFor({ sources: [new FakeSource([definition('spawn_agent', EToolEffect.Write)])] })
    const outcome = await decide({
      hook,
      call: callOf({ name: 'spawn_agent', effect: EToolEffect.Write }),
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Ask)
  })

  it('lets a source-declared tool through when the handle is trusted', async () => {
    const hook = hookFor({
      sources: [new FakeSource([definition('spawn_agent', EToolEffect.Write)])],
      trust: new FixedTrust(true),
    })
    const outcome = await decide({
      hook,
      call: callOf({ name: 'spawn_agent', effect: EToolEffect.Write }),
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
  })

  it('falls back to the call effect when the registry does not know the tool', async () => {
    const hook = hookFor({})
    const outcome = await decide({
      hook,
      call: callOf({ name: 'mcp__fs__write', effect: EToolEffect.Write }),
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Ask)
  })

  it('lets an unknown-prefixed read call through without consulting trust', async () => {
    const hook = hookFor({})
    const outcome = await decide({
      hook,
      call: callOf({ name: 'mcp__fs__read', effect: EToolEffect.Read }),
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
  })

  it('stops treating a source-declared name as MCP once the source drops it', async () => {
    const held = [definition('spawn_agent', EToolEffect.Write)]
    const hook = hookFor({ sources: [new FakeSource(held)] })

    const present = await decide({ hook, call: callOf({ name: 'spawn_agent', effect: EToolEffect.Write }) })
    expect(present.decision).toBe(EBeforeToolDecision.Ask)

    held.pop()

    const absent = await decide({ hook, call: callOf({ name: 'spawn_agent', effect: EToolEffect.Write }) })
    expect(absent.decision).toBe(EBeforeToolDecision.Allow)
  })

  it('sorts before both project-path resolution and the read-before-write recorder', () => {
    const resolveProjectPaths = new ResolveProjectPathsHook([])
    const readBeforeWrite = new ReadBeforeWriteHook(new NoViewState(), [])
    const boundary = hookFor({})

    const ordered = orderHooks([readBeforeWrite, boundary, resolveProjectPaths])

    expect(ordered.map((hook) => hook.name)).toEqual([
      'workspaceBoundary',
      'resolveProjectPaths',
      'readBeforeWrite',
    ])
  })

  it('asks rather than fail open when no trust port is registered', async () => {
    const container = createIsolatedContainer()
    container.register(portToken(ToolRegistry), {
      useValue: new InMemoryToolRegistry([definition('mcp__fs__write', EToolEffect.Write)]),
    })

    const hook = createWorkspaceBoundaryHook({ container })
    const outcome = await decide({
      hook,
      call: callOf({ name: 'mcp__fs__write', effect: EToolEffect.Write }),
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Ask)
  })
})
