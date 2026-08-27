import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

import {
  EBeforeToolDecision,
  EToolEffect,
  toCallId,
  type AfterTool,
  type BeforeTool,
  type ToolCall,
  type ToolOutcome,
} from '@dltech/atlas-core'

import { createHarnessContainer } from '../../container/create-harness-container'
import { disposeAll } from '../../container/disposal'
import type { DependencyContainer } from '../../container/injection'
import { WorkspaceRoot } from '../../container/tokens'
import type { HookChain, RegisteredHook } from '../registry'
import { resolveHookChain } from '../resolve-hooks'

let root = ''
let container: DependencyContainer
let chain: HookChain

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'atlas-file-state-wiring-'))
  container = createHarnessContainer()
  container.register(WorkspaceRoot, { useValue: root })
  chain = resolveHookChain({ container })
})

afterAll(async () => {
  await disposeAll({ container })
  rmSync(root, { recursive: true, force: true })
})

function hookNamed<TPhase>(args: {
  hooks: readonly RegisteredHook<TPhase>[]
  name: string
  phase: string
}): RegisteredHook<TPhase> {
  const matching = args.hooks.filter((hook) => hook.name === args.name)
  const [only] = matching
  if (only === undefined || matching.length > 1) {
    const resolved = args.hooks.map((hook) => hook.name).join(', ')
    throw new Error(
      `${args.phase} holds ${matching.length} hooks named "${args.name}" rather than exactly one; the container resolved [${resolved}]`,
    )
  }

  return only
}

const gate = (): RegisteredHook<BeforeTool> =>
  hookNamed({ hooks: chain.beforeTool, name: 'readBeforeWrite', phase: 'beforeTool' })

const scribe = (): RegisteredHook<AfterTool> =>
  hookNamed({ hooks: chain.afterTool, name: 'recordFileState', phase: 'afterTool' })

const callTo = (args: { name: string; input: unknown; effect: EToolEffect }): ToolCall => ({
  callId: toCallId('call-1'),
  name: args.name,
  input: args.input,
  effect: args.effect,
})

const editing = (path: string): ToolCall =>
  callTo({
    name: 'edit',
    input: { path, oldString: 'before', newString: 'after' },
    effect: EToolEffect.Write,
  })

const overwriting = (path: string): ToolCall =>
  callTo({ name: 'write', input: { path, content: 'after\n' }, effect: EToolEffect.Write })

const readingWhole = (path: string): ToolCall =>
  callTo({ name: 'read', input: { path }, effect: EToolEffect.Read })

const readingFrom = (args: { path: string; offset: number }): ToolCall =>
  callTo({
    name: 'read',
    input: { path: args.path, offset: args.offset },
    effect: EToolEffect.Read,
  })

const succeeded: ToolOutcome = { ok: true, output: undefined, modelText: 'before\n' }

const decisionOf = async (call: ToolCall): Promise<EBeforeToolDecision> =>
  (await gate().run({ call })).decision

const havingObserved = (call: ToolCall): Promise<unknown> => scribe().run({ call, result: succeeded })

const fileHolding = (args: { name: string; text: string }): string => {
  const path = join(root, args.name)
  writeFileSync(path, args.text)
  return path
}

const indexOfHook = (name: string): number =>
  chain.beforeTool.findIndex((hook) => hook.name === name)

describe('the file-state hooks resolved from one container', () => {
  it('denies an edit to a file nothing has read yet', async () => {
    const path = fileHolding({ name: 'unread.ts', text: 'before\n' })

    expect(await decisionOf(editing(path))).toBe(EBeforeToolDecision.Deny)
  })

  it('allows that edit once the scribe records the read, proving both hooks share one store', async () => {
    const path = fileHolding({ name: 'read-then-edited.ts', text: 'before\n' })

    expect(await decisionOf(editing(path))).toBe(EBeforeToolDecision.Deny)

    await havingObserved(readingWhole(path))

    expect(await decisionOf(editing(path))).toBe(EBeforeToolDecision.Allow)
  })

  it('carries the breadth of the read through the container, so a windowed view amends but never overwrites', async () => {
    const path = fileHolding({ name: 'windowed.ts', text: 'one\ntwo\nthree\n' })

    await havingObserved(readingFrom({ path, offset: 2 }))

    expect(await decisionOf(overwriting(path))).toBe(EBeforeToolDecision.Deny)
    expect(await decisionOf(editing(path))).toBe(EBeforeToolDecision.Allow)
  })

  it('registers each hook exactly once, alongside the boundary guard', () => {
    const named = (hooks: readonly RegisteredHook<unknown>[], name: string): number =>
      hooks.filter((hook) => hook.name === name).length

    expect(named(chain.beforeTool, 'readBeforeWrite')).toBe(1)
    expect(named(chain.afterTool, 'recordFileState')).toBe(1)
    expect(named(chain.beforeTool, 'workspaceBoundary')).toBe(1)
  })

  it('asks the boundary guard first, so an escaping path is refused for escaping rather than for being unread', () => {
    const boundary = indexOfHook('workspaceBoundary')

    expect(boundary).toBeGreaterThanOrEqual(0)
    expect(indexOfHook('readBeforeWrite')).toBeGreaterThan(boundary)
  })
})
