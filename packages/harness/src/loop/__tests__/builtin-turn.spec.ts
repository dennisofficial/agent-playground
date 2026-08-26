import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultRules, type Event, type EventOfType } from '@dltech/atlas-core'

import { createDeltaChannel, createPublishingTurnRunner, type ChannelSignal } from '../../channel'
import { createBoundaryHook } from '../../hooks/boundary'
import { createHookRegistry } from '../../hooks/registry'
import { scriptedModel, type ScriptedStep } from '../../model/testing/scripted-model'
import { createEditTool } from '../../tools/builtin/edit'
import { createReadTool } from '../../tools/builtin/read'
import { createDispatch } from '../../tools/dispatch'
import { createToolRegistry } from '../../tools/registry'
import { buildHarness, ETurnStatus, type AtlasHarness } from '..'
import { createTempDatabase, type TempDatabase } from './temp-database'

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

  const registry = createToolRegistry([createReadTool(), createEditTool()])
  const channel = createDeltaChannel()
  const seen: ChannelSignal[] = []

  const runner = createPublishingTurnRunner({
    channel,
    deps: {
      log: harness.log,
      model: harness.model,
      ids: harness.ids,
      rules: defaultRules({ root: workspace, tools: registry.declarations() }),
      tools: registry.declarations(),
      dispatch: createDispatch({
        registry,
        hooks: createHookRegistry({ beforeTool: [createBoundaryHook({ root: workspace })] }),
      }),
    },
  })

  const branch = await harness.branches.create({})
  channel.subscribe({ branchId: branch.id, listener: (signal) => void seen.push(signal) })

  return { harness, workspace, runner, branchId: branch.id, seen }
}

const resultOf = (events: readonly Event[]): EventOfType<'tool-result'> => {
  const found = events.find((event): event is EventOfType<'tool-result'> => event.type === 'tool-result')
  if (found === undefined) throw new Error('no tool result was recorded')
  return found
}

describe('a turn that drives a real builtin tool', () => {
  it('reads a file off the developer disk and completes on the following step', async () => {
    const { harness, workspace, runner, branchId } = await openWorkspace((root) => [
      { calls: [{ callId: 'call-1', name: 'read', input: { path: join(root, 'alpha.ts') } }] },
      { text: 'alpha.ts declares one export' },
    ])
    writeFileSync(join(workspace, 'alpha.ts'), 'export const alpha = 1\n')

    const outcome = await runner.say({ branchId, text: 'what is in alpha.ts?' })
    const events = await harness.log.read({ branchId })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(events.map((event) => event.type)).toEqual([
      'user-said',
      'tool-called',
      'tool-result',
      'assistant-said',
    ])
    expect(resultOf(events).modelText).toBe('1\texport const alpha = 1')
  })

  it('edits a file on disk and records a diff the transcript can render', async () => {
    const { harness, workspace, runner, branchId } = await openWorkspace((root) => [
      {
        calls: [
          {
            callId: 'call-1',
            name: 'edit',
            input: { path: join(root, 'beta.ts'), oldString: 'let x = 1', newString: 'const x = 2' },
          },
        ],
      },
      { text: 'done' },
    ])
    writeFileSync(join(workspace, 'beta.ts'), 'let x = 1\n')

    const outcome = await runner.say({ branchId, text: 'make x a const' })
    const events = await harness.log.read({ branchId })
    const output = resultOf(events).output as { diff: string }

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(readFileSync(join(workspace, 'beta.ts'), 'utf8')).toBe('const x = 2\n')
    expect(output.diff).toContain('-let x = 1')
    expect(output.diff).toContain('+const x = 2')
  })

  it('records the guard denial rather than touching a file outside the workspace', async () => {
    const { harness, runner, branchId } = await openWorkspace(() => [
      { calls: [{ callId: 'call-1', name: 'read', input: { path: '/etc/passwd' } }] },
      { text: 'I cannot read outside the workspace' },
    ])

    const outcome = await runner.say({ branchId, text: 'read /etc/passwd' })
    const events = await harness.log.read({ branchId })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(events.map((event) => event.type)).toEqual([
      'user-said',
      'tool-called',
      'tool-denied',
      'assistant-said',
    ])
  })

  it('opens and ends one step per model step, and none for the settlement', async () => {
    const { runner, workspace, branchId, seen } = await openWorkspace((root) => [
      { calls: [{ callId: 'call-1', name: 'read', input: { path: join(root, 'gamma.ts') } }] },
      { text: 'one export' },
    ])
    writeFileSync(join(workspace, 'gamma.ts'), 'export const gamma = 1\n')

    await runner.say({ branchId, text: 'what is in gamma.ts?' })

    const started = seen.filter((signal) => signal.type === 'step-started').length
    const ended = seen.filter((signal) => signal.type === 'step-ended').length
    expect({ started, ended }).toEqual({ started: 2, ended: 2 })
  })
})
