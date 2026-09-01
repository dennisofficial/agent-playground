import { toCallId, type EventDraft, type RunId, type ThreadId } from '@dltech/atlas-core'

import { scriptedModel } from '../../model/testing/scripted-model'
import type { DispatchableCall, ToolDispatcher } from '../../tools/dispatch'
import { buildHarness, type AtlasHarness } from '..'
import { createTempDatabase, type TempDatabase } from './temp-database'

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

export function keepOpen(entry: { harness: AtlasHarness; temp: TempDatabase }): void {
  opened.push(entry)
}

export async function discardOpened(): Promise<void> {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
}

export async function openLog(): Promise<AtlasHarness> {
  const temp = createTempDatabase()
  const harness = await buildHarness({
    databaseUrl: temp.databaseUrl,
    model: scriptedModel({ script: [] }),
  })
  keepOpen({ harness, temp })
  return harness
}

export async function branchWithCalls(args: {
  harness: AtlasHarness
  calls: readonly { callId: string; name: string; input?: unknown; ordinal?: number }[]
}): Promise<{ threadId: ThreadId; runId: RunId }> {
  const thread = await args.harness.threads.create({})
  const runId = args.harness.ids.nextRunId()
  await args.harness.log.append({
    threadId: thread.id,
    runId,
    drafts: [
      { type: 'user-said', text: 'edit a.ts' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'editing' }] },
      ...args.calls.map(
        (call, ordinal): EventDraft => ({
          type: 'tool-called',
          callId: toCallId(call.callId),
          name: call.name,
          input: call.input ?? {},
          ordinal: call.ordinal ?? ordinal,
        }),
      ),
    ],
  })

  return { threadId: thread.id, runId }
}

export function scriptedDispatch(args: {
  seen: DispatchableCall[]
  draftsFor?: (call: DispatchableCall) => readonly EventDraft[]
}): ToolDispatcher {
  const dispatch = async ({ call }: { call: DispatchableCall }): Promise<readonly EventDraft[]> => {
    args.seen.push(call)
    return (
      args.draftsFor?.(call) ?? [
        {
          type: 'tool-result',
          callId: call.callId,
          name: call.name,
          output: 'done',
          modelText: 'done',
        },
      ]
    )
  }

  return { dispatch }
}
