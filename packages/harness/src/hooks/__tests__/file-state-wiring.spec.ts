import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

import {
  EBeforeToolDecision,
  EToolEffect,
  toCallId,
  type AfterTool,
  type BeforeTool,
  toThreadId,
  ToolDefinition,
  type ThreadId,
  type ToolCall,
} from '@dltech/atlas-core'

import { createHarnessContainer } from '../../container/create-harness-container'
import { disposeAll } from '../../container/disposal'
import { portToken, type DependencyContainer } from '../../container/injection'
import { WorkspaceRoot } from '../../container/tokens'
import { GrepTool } from '../../tools/builtin/grep'
import { ReadTool } from '../../tools/builtin/read'
import { WriteTool } from '../../tools/builtin/write'
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

const parent = toThreadId('thread-parent')
const child = toThreadId('thread-child')

const callTo = (args: {
  name: string
  input: unknown
  effect: EToolEffect
  threadId?: ThreadId
}): ToolCall => ({
  callId: toCallId('call-1'),
  name: args.name,
  input: args.input,
  effect: args.effect,
  threadId: args.threadId ?? parent,
})

const editing = (path: string, threadId?: ThreadId): ToolCall =>
  callTo({
    name: 'edit',
    input: { path, oldString: 'before', newString: 'after' },
    effect: EToolEffect.Write,
    ...(threadId === undefined ? {} : { threadId }),
  })

const overwriting = (path: string, threadId?: ThreadId): ToolCall =>
  callTo({
    name: 'write',
    input: { path, content: 'after\n' },
    effect: EToolEffect.Write,
    ...(threadId === undefined ? {} : { threadId }),
  })

const beyondTheCall = { projectDirectory: '/w', events: [], signal: new AbortController().signal }

const decisionOf = async (call: ToolCall): Promise<EBeforeToolDecision> =>
  (await gate().run({ call, ...beyondTheCall })).decision

const readTool = new ReadTool()

const havingRead = async (
  input: {
    path: string
    offset?: number
    limit?: number
  },
  threadId: ThreadId = parent,
): Promise<void> => {
  const result = await readTool.invoke({
    input,
    signal: new AbortController().signal,
    idempotencyKey: 'wiring-read',
    projectDirectory: root,
    threadId,
  })
  if (!result.ok) throw new Error(result.reason)

  await scribe().run({
    call: callTo({ name: 'read', input, effect: EToolEffect.Read, threadId }),
    result,
  })
}

const grepTool = new GrepTool()

const havingSearched = async (
  input: { pattern: string; path?: string },
  threadId: ThreadId = parent,
): Promise<void> => {
  const result = await grepTool.invoke({
    input,
    signal: new AbortController().signal,
    idempotencyKey: 'wiring-grep',
    projectDirectory: root,
    threadId,
  })
  if (!result.ok) throw new Error(result.reason)

  await scribe().run({
    call: callTo({ name: 'grep', input, effect: EToolEffect.Read, threadId }),
    result,
  })
}

const writeTool = new WriteTool()

const havingWritten = async (
  input: { path: string; content: string },
  threadId: ThreadId = parent,
): Promise<void> => {
  const result = await writeTool.invoke({
    input,
    signal: new AbortController().signal,
    idempotencyKey: 'wiring-write',
    projectDirectory: root,
    threadId,
  })
  if (!result.ok) throw new Error(result.reason)

  await scribe().run({
    call: callTo({ name: 'write', input, effect: EToolEffect.Write, threadId }),
    result,
  })
}

const linesNumbering = (count: number): string =>
  `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')}\n`

const fileHolding = (args: { name: string; text: string }): string => {
  const path = join(root, args.name)
  writeFileSync(path, args.text)
  return path
}

describe('the file-state hooks resolved from one container', () => {
  it('denies an overwrite of a file nothing has read yet, and allows the edit beside it', async () => {
    const path = fileHolding({ name: 'unread.ts', text: 'before\n' })

    expect(await decisionOf(overwriting(path))).toBe(EBeforeToolDecision.Deny)
    expect(await decisionOf(editing(path))).toBe(EBeforeToolDecision.Allow)
  })

  it('allows that overwrite once the scribe records the read, proving both hooks share one store', async () => {
    const path = fileHolding({ name: 'read-then-overwritten.ts', text: 'before\n' })

    expect(await decisionOf(overwriting(path))).toBe(EBeforeToolDecision.Deny)

    await havingRead({ path })

    expect(await decisionOf(overwriting(path))).toBe(EBeforeToolDecision.Allow)
  })

  it('lets a search stand in for the read an edit of a changed file needs', async () => {
    const path = fileHolding({ name: 'searched-then-edited.ts', text: 'before\n' })

    await havingRead({ path })
    writeFileSync(path, 'before, and a line nobody has read\n')

    expect(await decisionOf(editing(path))).toBe(EBeforeToolDecision.Deny)

    await havingSearched({ pattern: 'before', path })

    expect(await decisionOf(editing(path))).toBe(EBeforeToolDecision.Allow)
  })

  it('does not let that search stand in for the whole-file read an overwrite needs', async () => {
    const path = fileHolding({ name: 'searched-then-overwritten.ts', text: 'before\n' })

    await havingSearched({ pattern: 'before', path })

    expect(await decisionOf(overwriting(path))).toBe(EBeforeToolDecision.Deny)
    expect(await decisionOf(editing(path))).toBe(EBeforeToolDecision.Allow)
  })

  it('leaves a whole-file read intact when a search only matched the file again', async () => {
    const path = fileHolding({ name: 'read-then-searched.ts', text: 'before\n' })

    await havingRead({ path })
    await havingSearched({ pattern: 'before', path })

    expect(await decisionOf(overwriting(path))).toBe(EBeforeToolDecision.Allow)
  })

  it('carries the breadth of the read through the container, so a windowed view amends but never overwrites', async () => {
    const path = fileHolding({ name: 'windowed.ts', text: 'one\ntwo\nthree\n' })

    await havingRead({ path, offset: 2 })

    expect(await decisionOf(overwriting(path))).toBe(EBeforeToolDecision.Deny)
    expect(await decisionOf(editing(path))).toBe(EBeforeToolDecision.Allow)
  })

  it('denies a whole-file overwrite after a bare read the line limit cut short', async () => {
    const path = fileHolding({ name: 'longer-than-one-read.ts', text: linesNumbering(2_500) })

    await havingRead({ path })

    expect(await decisionOf(overwriting(path))).toBe(EBeforeToolDecision.Deny)
    expect(await decisionOf(editing(path))).toBe(EBeforeToolDecision.Allow)
  })

  it('allows a whole-file overwrite after a bare read that did return the whole file', async () => {
    const path = fileHolding({ name: 'short-enough.ts', text: linesNumbering(10) })

    await havingRead({ path })

    expect(await decisionOf(overwriting(path))).toBe(EBeforeToolDecision.Allow)
  })

  it('does not let a sub-agent’s read satisfy the parent’s guard', async () => {
    const path = fileHolding({ name: 'read-by-sub-agent.ts', text: 'before\n' })

    await havingRead({ path }, child)

    expect(await decisionOf(overwriting(path, child))).toBe(EBeforeToolDecision.Allow)
    expect(await decisionOf(overwriting(path, parent))).toBe(EBeforeToolDecision.Deny)
  })

  it('refuses the second writer once the first has moved the file underneath it', async () => {
    const path = fileHolding({ name: 'two-writers.ts', text: 'before\n' })

    await havingRead({ path }, parent)
    await havingRead({ path }, child)

    expect(await decisionOf(overwriting(path, parent))).toBe(EBeforeToolDecision.Allow)

    await havingWritten({ path, content: 'the child got there first\n' }, child)

    expect(await decisionOf(overwriting(path, child))).toBe(EBeforeToolDecision.Allow)

    const outcome = await gate().run({ call: overwriting(path, parent), ...beyondTheCall })
    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
    expect('reason' in outcome ? outcome.reason : '').toContain('read it again')
  })

  it('lets the refused thread recover by reading the file again', async () => {
    const path = fileHolding({ name: 'recovers-by-rereading.ts', text: 'before\n' })

    await havingRead({ path }, parent)
    await havingWritten({ path, content: 'the child got there first\n' }, child)

    expect(await decisionOf(overwriting(path, parent))).toBe(EBeforeToolDecision.Deny)

    await havingRead({ path }, parent)

    expect(await decisionOf(overwriting(path, parent))).toBe(EBeforeToolDecision.Allow)
  })

  it('binds the write tool to the verifying guard, not the pass-through default', async () => {
    const path = fileHolding({ name: 'guarded-by-the-container.ts', text: 'before\n' })

    await havingRead({ path }, parent)
    writeFileSync(path, 'somebody else got here first\n')

    const tools: readonly ToolDefinition[] = container.resolveAll(portToken(ToolDefinition))
    const write = tools.find((tool) => tool.name === 'write')
    if (write === undefined) throw new Error('the container registered no write tool')

    const outcome = await write.invoke({
      input: { path, content: 'too late\n' },
      signal: new AbortController().signal,
      idempotencyKey: 'container-guard',
      projectDirectory: root,
      threadId: parent,
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? '' : outcome.reason).toContain('read it again')
    expect(readFileSync(path, 'utf8')).toBe('somebody else got here first\n')
  })

  it('registers each hook exactly once', () => {
    const named = (hooks: readonly RegisteredHook<unknown>[], name: string): number =>
      hooks.filter((hook) => hook.name === name).length

    expect(named(chain.beforeTool, 'readBeforeWrite')).toBe(1)
    expect(named(chain.afterTool, 'recordFileState')).toBe(1)
  })
})
