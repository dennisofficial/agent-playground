import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import {
  defaultPipeline,
  EMPTY_PROMPT,
  EToolEffect,
  toCallId,
  type EventLogPort,
} from '@dltech/atlas-core'

import { buildHarness, ETurnStatus, LoopTurnRunner, type AtlasHarness } from '..'
import { scriptedModel } from '../../model/testing/scripted-model'
import { HookChain } from '../../hooks/registry'
import { EApprovalRouting, HookedToolDispatcher } from '../../tools/dispatch'
import { InMemoryToolRegistry } from '../../tools/registry'
import { createTempDatabase, type TempDatabase } from './temp-database'
import { COLLISION_TRANSCRIPT } from './reused-call-id.transcript'

const PROJECT_DIRECTORY = '/w'

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
})

const writeInput = z.object({ path: z.string(), content: z.string() })

async function openHarnessWithWriter(): Promise<AtlasHarness> {
  const temp = createTempDatabase()
  const harness = await buildHarness({
    databaseUrl: temp.databaseUrl,
    model: scriptedModel({
      script: [
        {
          text: 'writing it',
          calls: [{ callId: 'call-1', name: 'write', input: { path: 'notes.md', content: '# fresh' } }],
        },
        { text: 'written' },
      ],
    }),
  })
  opened.push({ harness, temp })
  return harness
}

function runnerFor(harness: AtlasHarness, root: string, log?: EventLogPort): LoopTurnRunner {
  const registry = new InMemoryToolRegistry([
    {
      name: 'write',
      description: 'write a file',
      effect: EToolEffect.Write,
      inputSchema: writeInput,
      invoke: async ({ input }) => {
        const parsed = writeInput.safeParse(input)
        if (!parsed.success) return { ok: false, reason: 'write needs a path and content' }

        await Bun.write(join(root, parsed.data.path), parsed.data.content)
        return { ok: true, output: { path: parsed.data.path }, modelText: `wrote ${parsed.data.path}` }
      },
    },
  ])

  return new LoopTurnRunner({
    log: log ?? harness.log,
    model: harness.model,
    ids: harness.ids,
    assembly: defaultPipeline({ prompt: () => EMPTY_PROMPT, launchDirectory: PROJECT_DIRECTORY }),
    tools: () => registry.declarations(),
    dispatch: new HookedToolDispatcher({ approvals: EApprovalRouting.Operator, registry, hooks: new HookChain({}) }),
  })
}

describe('a provider that hands out the same call id twice (kimi numbers calls per request)', () => {
  it('dispatches the fresh call even though an ancient result carries the same id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atlas-workspace-'))
    const harness = await openHarnessWithWriter()
    const thread = await harness.threads.create({})

    await harness.log.append({
      threadId: thread.id,
      runId: harness.ids.nextRunId(),
      drafts: [
        { type: 'user-said', text: 'write old.md' },
        { type: 'assistant-said', parts: [{ type: 'text', text: 'on it' }] },
        { type: 'tool-called', callId: toCallId('call-1'), name: 'write', input: { path: 'old.md' }, ordinal: 0 },
        { type: 'tool-result', callId: toCallId('call-1'), name: 'write', output: { path: 'old.md' } },
        { type: 'assistant-said', parts: [{ type: 'text', text: 'old.md written' }] },
      ],
    })

    const runner = runnerFor(harness, root)
    const outcome = await runner.say({ threadId: thread.id, text: 'write notes.md' })
    expect(outcome.status).toBe(ETurnStatus.Completed)
    const events = await harness.log.read({ threadId: thread.id })
    expect(events.map((event) => event.type)).toEqual([
      'user-said',
      'assistant-said',
      'tool-called',
      'tool-result',
      'assistant-said',
      'user-said',
      'assistant-said',
      'tool-called',
      'tool-result',
      'assistant-said',
    ])
    expect(await Bun.file(join(root, 'notes.md')).text()).toBe('# fresh')
    rmSync(root, { recursive: true, force: true })
  })
})

describe('the transcript where it happened (thread brn_55fd05fb, kimi-k3-fast, 2026-09-04)', () => {
  it('settles the calls the stall stranded, then runs the fresh bash_181 under a new id', async () => {
    const temp = createTempDatabase()
    const harness = await buildHarness({
      databaseUrl: temp.databaseUrl,
      model: scriptedModel({
        script: [
          {
            text: 'checking #377',
            calls: [
              {
                callId: 'bash_181',
                name: 'bash',
                input: { command: 'gh pr checks 377 2>&1 | grep -i fail', description: "List #377's failing checks" },
              },
            ],
          },
          { text: 'the five failures are…' },
        ],
      }),
    })
    opened.push({ harness, temp })
    const thread = await harness.threads.create({})

    await harness.log.append({
      threadId: thread.id,
      runId: harness.ids.nextRunId(),
      drafts: COLLISION_TRANSCRIPT,
    })

    const ran: string[] = []
    const registry = new InMemoryToolRegistry([
      {
        name: 'bash',
        description: 'run a command',
        effect: EToolEffect.Write,
        inputSchema: z.object({ command: z.string(), description: z.string() }),
        invoke: async ({ input }) => {
          const parsed = z.object({ command: z.string() }).safeParse(input)
          if (!parsed.success) return { ok: false, reason: 'bash needs a command' }

          ran.push(parsed.data.command)
          return { ok: true, output: { command: parsed.data.command }, modelText: 'ok' }
        },
      },
    ])

    const runner = new LoopTurnRunner({
      log: harness.log,
      model: harness.model,
      ids: harness.ids,
      assembly: defaultPipeline({ prompt: () => EMPTY_PROMPT, launchDirectory: PROJECT_DIRECTORY }),
      tools: () => registry.declarations(),
      dispatch: new HookedToolDispatcher({ approvals: EApprovalRouting.Operator, registry, hooks: new HookChain({}) }),
    })

    const outcome = await runner.say({ threadId: thread.id, text: 'continue' })

    expect(outcome.status).toBe(ETurnStatus.Completed)

    const stranded = COLLISION_TRANSCRIPT.flatMap((draft, index) =>
      draft.type === 'tool-called' && index > 3 ? [draft.input as { command: string }] : [],
    )
    expect(stranded).toHaveLength(3)
    expect(ran).toEqual([...stranded.map((call) => call.command), 'gh pr checks 377 2>&1 | grep -i fail'])

    const events = await harness.log.read({ threadId: thread.id })
    const freshCall = events.filter((event) => event.type === 'tool-called').at(-1)
    expect(freshCall?.type === 'tool-called' ? freshCall.callId : '').toBe(toCallId('bash_181~2'))
    expect(events.filter((event) => event.type === 'tool-result')).toHaveLength(5)
  })
})

describe('a turn whose committed call the log no longer holds as pending', () => {
  it('fails loudly naming the call instead of going idle with nothing to say', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atlas-workspace-'))
    const harness = await openHarnessWithWriter()
    const thread = await harness.threads.create({})

    const droppingReads: EventLogPort = {
      read: async (args) =>
        (await harness.log.read(args)).filter((event) => event.type !== 'tool-called'),
      readOwn: async (args) =>
        (await harness.log.readOwn(args)).filter((event) => event.type !== 'tool-called'),
      append: (args) => harness.log.append(args),
      head: (args) => harness.log.head(args),
    }

    const runner = runnerFor(harness, root, droppingReads)
    const outcome = await runner.say({ threadId: thread.id, text: 'write notes.md' })

    expect(outcome.status).toBe(ETurnStatus.Failed)
    expect(outcome.status === ETurnStatus.Failed ? outcome.message : '').toMatch(/call-1/)
    expect(await Bun.file(join(root, 'notes.md')).exists()).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })
})
