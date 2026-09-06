import { testRender } from '@opentui/react/test-utils'
import { afterAll, describe, expect, test } from 'bun:test'
import React from 'react'

import type { ToolCall } from '../../../../store'
import { EDetail } from '../../../../store/tools'
import { grammarsReady, teardown } from '../../../markdown/__tests__/harness'
import { NOT_EXPANDABLE } from '../more-toggle'
import { ToolDetail } from '../tool-detail'
import { ToolTerminal } from '../tool-terminal'

await grammarsReady()

const QUIET_MS = 400

const call = (args: { name: string; input: unknown; output: unknown }): ToolCall =>
  ({
    callId: `call-${args.name}`,
    name: args.name,
    input: args.input,
    output: args.output,
    settled: true,
    failed: false,
  }) as unknown as ToolCall

const BASH = call({
  name: 'bash',
  input: { command: 'ls -la /tmp && echo done', description: 'list' },
  output: { stdout: 'a\nb\nc', exitCode: 0 },
})

const EDIT = call({
  name: 'edit',
  input: { path: '/tmp/a.ts', oldString: 'a', newString: 'b' },
  output: {
    path: '/tmp/a.ts',
    diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n const x = 1\n-const y = a\n+const y = b\n const z = 3\n',
  },
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type Setup = Awaited<ReturnType<typeof testRender>>

const mounted: Setup[] = []

afterAll(async () => {
  for (const setup of mounted) await teardown(setup)
})

/**
 * Highlighting lands asynchronously, so the block is allowed a few frames after mount. Once it has
 * settled, an idle block must request nothing: a block that keeps drawing frames with nothing to
 * show is a render loop, and one such block pins a core for as long as it is on screen.
 */
const idleFrames = async (node: React.ReactNode): Promise<{ frames: number; frame: string }> => {
  const setup = await testRender(node, { width: 100, height: 20 })
  mounted.push(setup)
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  await setup.flush()
  await sleep(QUIET_MS)
  await setup.flush()
  const before = setup.renderer.getStats().frameCount
  await sleep(QUIET_MS)
  return { frames: setup.renderer.getStats().frameCount - before, frame: setup.captureCharFrame() }
}

describe('a settled tool block left alone', () => {
  test('a bash terminal draws no idle frames once its command is highlighted', async () => {
    const { frames, frame } = await idleFrames(
      <ToolTerminal call={BASH} inner={80} expand={NOT_EXPANDABLE} />,
    )
    expect(frame).toContain('$ ls -la /tmp && echo done')
    expect(frames).toBe(0)
  })

  test('an edit diff draws no idle frames once its hunk is highlighted', async () => {
    const { frames, frame } = await idleFrames(
      <ToolDetail detail={EDetail.Diff} call={EDIT} inner={80} cwd="/tmp" expand={NOT_EXPANDABLE} />,
    )
    expect(frame).toContain('const y = b')
    expect(frames).toBe(0)
  })
})
