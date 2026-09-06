import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it, mock } from 'bun:test'
import React from 'react'

import { toCallId } from '@dltech/atlas-core'

import { ECallState, type ToolCall, type ToolRun } from '../../../../store'

const { ToolDetail: RealToolDetail } = await import('../tool-detail')

type DetailProps = React.ComponentProps<typeof RealToolDetail>

const detailRenders = new Map<string, number>()

function CountedDetail(props: DetailProps): React.ReactNode {
  detailRenders.set(props.call.callId, (detailRenders.get(props.call.callId) ?? 0) + 1)
  return <RealToolDetail {...props} />
}

void mock.module('../tool-detail', () => ({ ToolDetail: CountedDetail }))

const { ToolRunBlock } = await import('../tool-run-block')
const { grammarsReady, teardown } = await import('../../../markdown/__tests__/harness')
const { letTimersRun } = await import('../../../__tests__/ticking')
const { frameSettled } = await import('../../../__tests__/waiting')

await grammarsReady()

const WIDTH = 100

const HEIGHT = 30

const CWD = '/repo'

const DIFF = [
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,3 +1,3 @@',
  ' const x = 1',
  '-const y = a',
  '+const y = b',
  ' const z = 3',
  '',
].join('\n')

const call = (args: {
  id: string
  name: string
  input: unknown
  output: unknown
  state: ECallState
  modelText?: string
}): ToolCall => ({
  callId: toCallId(args.id),
  name: args.name,
  input: args.input,
  output: args.output,
  modelText: args.modelText ?? '',
  state: args.state,
  note: null,
  at: null,
  settledAt: args.state === ECallState.Pending ? null : '2026-08-29T00:00:00.000Z',
})

const EDITED = call({
  id: 'edited',
  name: 'edit',
  input: { path: `${CWD}/a.ts`, oldString: 'a', newString: 'b' },
  output: { path: `${CWD}/a.ts`, diff: DIFF },
  state: ECallState.Ok,
})

const READING = call({
  id: 'reading',
  name: 'read',
  input: { path: `${CWD}/z.ts` },
  output: undefined,
  state: ECallState.Pending,
  modelText: 'one\ntwo',
})

const LIVE_RUN: ToolRun = { key: 'tools:edited', openedBy: EDITED.callId, calls: [EDITED, READING] }

describe('a shimmer tick on a live tool run', () => {
  it('redraws the spinner without re-rendering the settled detail beneath it', async () => {
    const setup = await testRender(
      <box flexDirection="column" width={WIDTH} height={HEIGHT}>
        <ToolRunBlock run={LIVE_RUN} width={WIDTH} cwd={CWD} />
      </box>,
      { width: WIDTH, height: HEIGHT },
    )
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
    try {
      await frameSettled({ setup })
      const detailBefore = detailRenders.get(EDITED.callId) ?? 0
      expect(detailBefore).toBeGreaterThan(0)
      const framesBefore = setup.renderer.getStats().frameCount

      await letTimersRun({ setup, ms: 300 })

      expect(setup.renderer.getStats().frameCount - framesBefore).toBeGreaterThanOrEqual(2)
      expect(detailRenders.get(EDITED.callId)).toBe(detailBefore)
    } finally {
      await teardown(setup)
    }
  }, 30_000)
})
