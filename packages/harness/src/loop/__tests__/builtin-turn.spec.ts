import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultPipeline, EMPTY_PROMPT, type Event, type EventOfType } from '@dltech/atlas-core'

import { createDeltaChannel, PublishingTurnRunner, type ChannelSignal } from '../../channel'
import { InMemoryFileReadState } from '../../files/read-state'
import { createReadBeforeWriteHook } from '../../hooks/read-before-write'
import { createRecordFileStateHook } from '../../hooks/record-file-state'
import { HookChain } from '../../hooks/registry'
import { scriptedModel, type ScriptedStep } from '../../model/testing/scripted-model'
import { EditTool } from '../../tools/builtin/edit'
import { ReadTool } from '../../tools/builtin/read'
import { WriteTool } from '../../tools/builtin/write'
import { EApprovalRouting, HookedToolDispatcher } from '../../tools/dispatch'
import { InMemoryToolRegistry } from '../../tools/registry'
import { buildHarness, ETurnStatus, type AtlasHarness } from '..'
import { createTempDatabase, type TempDatabase } from './temp-database'

const PROJECT_DIRECTORY = '/w'

const opened: { harness: AtlasHarness; temp: TempDatabase; workspace: string }[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
    rmSync(entry.workspace, { recursive: true, force: true })
  }
})

async function openWorkspace(scriptFor: (workspace: string) => readonly ScriptedStep[]) {
  const workspace = mkdtempSync(join(tmpdir(), 'atlas-builtin-'))
  const temp = createTempDatabase()
  const harness = await buildHarness({
    databaseUrl: temp.databaseUrl,
    model: scriptedModel({ script: scriptFor(workspace) }),
  })
  opened.push({ harness, temp, workspace })

  const registry = new InMemoryToolRegistry([new ReadTool(), new EditTool(), new WriteTool()])
  const declarations = registry.declarations()
  const viewed = new InMemoryFileReadState()
  const channel = createDeltaChannel()
  const seen: ChannelSignal[] = []

  const runner = new PublishingTurnRunner({
    channel,
    deps: {
      log: harness.log,
      model: harness.model,
      ids: harness.ids,
      assembly: defaultPipeline({ prompt: () => EMPTY_PROMPT, launchDirectory: PROJECT_DIRECTORY }),
      tools: declarations,
      dispatch: new HookedToolDispatcher({
        approvals: EApprovalRouting.Operator,
        registry,
        hooks: new HookChain({
          beforeTool: [
            createReadBeforeWriteHook({ seen: viewed, tools: declarations }),
          ],
          afterTool: [createRecordFileStateHook({ seen: viewed, tools: declarations })],
        }),
      }),
    },
  })

  const thread = await harness.threads.create({})
  channel.subscribe({ threadId: thread.id, listener: (signal) => void seen.push(signal) })

  return { harness, workspace, runner, threadId: thread.id, seen }
}

const resultOf = (args: {
  events: readonly Event[]
  name: string
}): EventOfType<'tool-result'> => {
  const found = args.events.find(
    (event): event is EventOfType<'tool-result'> =>
      event.type === 'tool-result' && event.name === args.name,
  )
  if (found === undefined) throw new Error(`no tool result was recorded for ${args.name}`)
  return found
}

const denialOf = (events: readonly Event[]): EventOfType<'tool-denied'> => {
  const found = events.find((event): event is EventOfType<'tool-denied'> => event.type === 'tool-denied')
  if (found === undefined) throw new Error('no tool denial was recorded')
  return found
}

describe('a turn that drives a real builtin tool', () => {
  it('reads a file off the developer disk and completes on the following step', async () => {
    const { harness, workspace, runner, threadId } = await openWorkspace((root) => [
      { calls: [{ callId: 'call-1', name: 'read', input: { path: join(root, 'alpha.ts') } }] },
      { text: 'alpha.ts declares one export' },
    ])
    writeFileSync(join(workspace, 'alpha.ts'), 'export const alpha = 1\n')

    const outcome = await runner.say({ threadId, text: 'what is in alpha.ts?' })
    const events = await harness.log.read({ threadId })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(events.map((event) => event.type)).toEqual([
      'user-said',
      'tool-called',
      'tool-result',
      'assistant-said',
    ])
    expect(resultOf({ events, name: 'read' }).modelText).toBe('1\texport const alpha = 1')
  })

  it('edits a file on disk and records a diff the transcript can render', async () => {
    const { harness, workspace, runner, threadId } = await openWorkspace((root) => [
      { calls: [{ callId: 'call-1', name: 'read', input: { path: join(root, 'beta.ts') } }] },
      {
        calls: [
          {
            callId: 'call-2',
            name: 'edit',
            input: { path: join(root, 'beta.ts'), oldString: 'let x = 1', newString: 'const x = 2' },
          },
        ],
      },
      { text: 'done' },
    ])
    writeFileSync(join(workspace, 'beta.ts'), 'let x = 1\n')

    const outcome = await runner.say({ threadId, text: 'make x a const' })
    const events = await harness.log.read({ threadId })
    const output = resultOf({ events, name: 'edit' }).output as { diff: string }

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(events.map((event) => event.type)).toEqual([
      'user-said',
      'tool-called',
      'tool-result',
      'tool-called',
      'tool-result',
      'assistant-said',
    ])
    expect(readFileSync(join(workspace, 'beta.ts'), 'utf8')).toBe('const x = 2\n')
    expect(output.diff).toContain('-let x = 1')
    expect(output.diff).toContain('+const x = 2')
  })

  it('refuses to overwrite a file the model never read, and leaves its bytes untouched', async () => {
    const { harness, workspace, runner, threadId } = await openWorkspace((root) => [
      {
        calls: [
          {
            callId: 'call-1',
            name: 'write',
            input: { path: join(root, 'delta.ts'), content: 'export const delta = 2\n' },
          },
        ],
      },
      { text: 'I have to read delta.ts before replacing it' },
    ])
    writeFileSync(join(workspace, 'delta.ts'), 'export const delta = 1\n')

    const outcome = await runner.say({ threadId, text: 'make delta 2' })
    const events = await harness.log.read({ threadId })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(events.map((event) => event.type)).toEqual([
      'user-said',
      'tool-called',
      'tool-denied',
      'assistant-said',
    ])
    expect(denialOf(events).reason).toContain('read it first')
    expect(readFileSync(join(workspace, 'delta.ts'), 'utf8')).toBe('export const delta = 1\n')
  })

  it('lets the overwrite through once the whole file has been read in the same turn', async () => {
    const { harness, workspace, runner, threadId } = await openWorkspace((root) => [
      { calls: [{ callId: 'call-1', name: 'read', input: { path: join(root, 'epsilon.ts') } }] },
      {
        calls: [
          {
            callId: 'call-2',
            name: 'write',
            input: { path: join(root, 'epsilon.ts'), content: 'export const epsilon = 2\n' },
          },
        ],
      },
      { text: 'epsilon is 2 now' },
    ])
    writeFileSync(join(workspace, 'epsilon.ts'), 'export const epsilon = 1\n')

    const outcome = await runner.say({ threadId, text: 'make epsilon 2' })
    const events = await harness.log.read({ threadId })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(events.map((event) => event.type)).toEqual([
      'user-said',
      'tool-called',
      'tool-result',
      'tool-called',
      'tool-result',
      'assistant-said',
    ])
    expect(readFileSync(join(workspace, 'epsilon.ts'), 'utf8')).toBe('export const epsilon = 2\n')
  })

  it('reads a file outside the workspace, which nothing walls off any more', async () => {
    const { harness, runner, threadId } = await openWorkspace(() => [
      { calls: [{ callId: 'call-1', name: 'read', input: { path: '/etc/hosts' } }] },
      { text: 'read it' },
    ])

    const outcome = await runner.say({ threadId, text: 'read /etc/hosts' })
    const events = await harness.log.read({ threadId })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(events.map((event) => event.type)).toEqual([
      'user-said',
      'tool-called',
      'tool-result',
      'assistant-said',
    ])
  })

  it('settles a tool that failed, so the turn finishes instead of stalling on the call', async () => {
    const { harness, runner, threadId } = await openWorkspace((root) => [
      { calls: [{ callId: 'call-1', name: 'read', input: { path: join(root, 'missing.ts') } }] },
      { text: 'missing.ts is not there' },
    ])

    const outcome = await runner.say({ threadId, text: 'read missing.ts' })
    const events = await harness.log.read({ threadId })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(events.map((event) => event.type)).toEqual([
      'user-said',
      'tool-called',
      'tool-result',
      'assistant-said',
    ])
    expect(resultOf({ events, name: 'read' }).error?.message.length).toBeGreaterThan(0)
  })

  it('publishes one step-started and one step-ended per model step, and none for the settlement', async () => {
    const { runner, workspace, threadId, seen } = await openWorkspace((root) => [
      { calls: [{ callId: 'call-1', name: 'read', input: { path: join(root, 'gamma.ts') } }] },
      { text: 'one export' },
    ])
    writeFileSync(join(workspace, 'gamma.ts'), 'export const gamma = 1\n')

    await runner.say({ threadId, text: 'what is in gamma.ts?' })

    const started = seen.filter((signal) => signal.type === 'step-started').length
    const ended = seen.filter((signal) => signal.type === 'step-ended').length
    expect({ started, ended }).toEqual({ started: 2, ended: 2 })
  })
})
