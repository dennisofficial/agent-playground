import { afterEach, describe, expect, it } from 'bun:test'

import {
  defaultPipeline,
  EMPTY_PROMPT,
  EShellStatus,
  type Event,
  type EventDraft,
} from '@dltech/atlas-core'

import { HookChain } from '../../../hooks/registry'
import { buildHarness, type AtlasHarness } from '../../../loop/build-harness'
import { createTempDatabase, type TempDatabase } from '../../../loop/__tests__/temp-database'
import type { TurnDeps } from '../../../loop/run-turn'
import { scriptedModel } from '../../../model/testing/scripted-model'
import { InMemoryToolRegistry } from '../../../tools/registry'
import { buildChildRunner } from '../child-runner'
import { agentTypeNamed } from './fixtures'

const PROJECT_DIRECTORY = '/w'

const OPERATOR_TEXT = 'the operator typed this at the parent'

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
})

const shellEnded = (command: string): EventDraft => ({
  type: 'background-shell-ended',
  shellId: 'sh_1',
  command,
  status: EShellStatus.Exited,
  exitCode: 0,
  output: 'done',
  droppedCharacters: 0,
  remainingCharacters: 0,
})

async function childTurn(args: {
  steering: readonly string[]
  notices: readonly EventDraft[]
}): Promise<{ events: readonly Event[]; operatorDrains: number }> {
  const temp = createTempDatabase()
  const model = scriptedModel({ script: [{ text: 'the child answered' }] })
  const harness = await buildHarness({ databaseUrl: temp.databaseUrl, model })
  opened.push({ harness, temp })

  let operatorDrains = 0
  const assembly = defaultPipeline({
    prompt: () => EMPTY_PROMPT,
    projectDirectory: PROJECT_DIRECTORY,
  })

  const parent: TurnDeps = {
    log: harness.log,
    model: harness.model,
    ids: harness.ids,
    assembly,
    projectDirectory: PROJECT_DIRECTORY,
    drainPending: async () => {
      operatorDrains += 1
      return [{ type: 'user-said', text: OPERATOR_TEXT }]
    },
  }

  const threadId = (await harness.threads.create({})).id
  await harness.log.append({
    threadId,
    runId: harness.ids.nextRunId(),
    drafts: [{ type: 'user-said', text: 'count the call sites of assemble' }],
  })

  const steering = [...args.steering]
  const notices = [...args.notices]

  const runner = buildChildRunner({
    agentType: agentTypeNamed({ name: 'explore' }),
    threadId,
    observe: () => undefined,
    observeContext: () => undefined,
    steering: () => steering.splice(0),
    deps: {
      turn: parent,
      tools: new InMemoryToolRegistry([]),
      hooks: new HookChain({}),
      drainNotices: async () => notices.splice(0),
      assemblyFor: () => assembly,
    },
  })

  await runner.runTurn({ threadId })

  return { events: await harness.log.read({ threadId }), operatorDrains }
}

describe('what a child drains before a step', () => {
  it("never reaches the operator's typed-ahead queue, which belongs to the parent", async () => {
    const { events, operatorDrains } = await childTurn({ steering: [], notices: [] })

    expect(operatorDrains).toBe(0)
    expect(
      events.map((event) => (event.type === 'user-said' ? event.text : event.type)),
    ).not.toContain(OPERATOR_TEXT)
  })

  it("takes its own steering first, then its own thread's notices", async () => {
    const { events, operatorDrains } = await childTurn({
      steering: ['stop at the first hit'],
      notices: [shellEnded('bun test')],
    })

    expect(operatorDrains).toBe(0)
    expect(events.map((event) => event.type)).toEqual([
      'user-said',
      'user-said',
      'background-shell-ended',
      'assistant-said',
    ])

    const steered = events[1]
    expect(steered?.type === 'user-said' ? steered.text : '').toBe('stop at the first hit')
  })
})
