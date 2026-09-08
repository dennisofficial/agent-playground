import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act, useCallback, useState } from 'react'

import { EContextSlot, toCallId } from '@dltech/atlas-core'

import { ECallState, type ContextAttachment, type ToolCall, type ToolRun } from '../../store'
import { ToolRunBlock } from '../components/blocks/tool-run-block'
import { contextKey } from '../components/blocks/tool-run-expansion'
import { teardown } from '../markdown/__tests__/harness'

const WIDTH = 100

const HEIGHT = 24

const CWD = '/repo'

let ordinal = 0

const call = (args: {
  name: string
  input?: unknown
  output?: unknown
  attachments?: readonly ContextAttachment[]
}): ToolCall => {
  ordinal += 1
  return {
    callId: toCallId(`c${ordinal}`),
    name: args.name,
    input: args.input ?? {},
    output: args.output,
    modelText: '',
    state: ECallState.Ok,
    note: null,
    at: null,
    settledAt: '2026-09-08T00:00:00.000Z',
    attachments: args.attachments ?? [],
  }
}

const runOf = (calls: readonly ToolCall[]): ToolRun => ({
  key: 'tools:c1',
  openedBy: calls[0]?.callId ?? toCallId('c0'),
  calls,
})

const read = (path: string, attachments: readonly ContextAttachment[] = []): ToolCall =>
  call({
    name: 'read',
    input: { path: `${CWD}/${path}` },
    output: { path: `${CWD}/${path}`, lines: 10 },
    attachments,
  })

const instructions = (path: string): ContextAttachment => ({
  id: `load-${path}`,
  slot: EContextSlot.NestedInstructions,
  name: `${CWD}/${path}`,
  content: '# Rules\n\nAlways run bun test.',
})

const hookNote = (slot: string, content: string): ContextAttachment => ({
  id: `hook-${slot}`,
  slot,
  name: 'additional-context',
  content,
})

async function frameOf(run: ToolRun, opened?: ReadonlySet<string>): Promise<string> {
  const setup = await testRender(
    <ToolRunBlock run={run} width={WIDTH} cwd={CWD} {...(opened === undefined ? {} : { opened })} />,
    { width: WIDTH, height: HEIGHT },
  )
  await setup.flush()
  const frame = setup.captureCharFrame()
  await teardown(setup)
  return frame
}

describe('context attached to a tool call', () => {
  it('hangs an instruction file under the call that pulled it in, named by its path', async () => {
    const frame = await frameOf(runOf([read('apps/api/src/index.ts', [instructions('apps/api/CLAUDE.md')])]))

    const rows = frame.split('\n')
    const call = rows.findIndex((row) => row.includes('apps/api/src/index.ts'))
    const attachment = rows.findIndex((row) => row.includes('⎿ apps/api/CLAUDE.md'))

    expect(call).toBeGreaterThanOrEqual(0)
    expect(attachment).toBeGreaterThan(call)
    expect(frame).not.toContain('Always run bun test')
  })

  it('names a hook attachment by the hook that spoke', async () => {
    const pushed = call({
      name: 'bash',
      input: { command: 'git push', description: 'git push pr' },
      output: { command: 'git push', stdout: '', exitCode: 0 },
      attachments: [hookNote('gitState', 'branch: main, 3 files dirty')],
    })
    const frame = await frameOf(runOf([pushed]))

    expect(frame).toContain('⎿ gitState')
    expect(frame).not.toContain('3 files dirty')
  })

  it('unfolds the injected text when the attachment is opened', async () => {
    const attachment = hookNote('gitState', 'branch: main, 3 files dirty')
    const pushed = call({
      name: 'bash',
      input: { command: 'git push' },
      output: { command: 'git push', stdout: '', exitCode: 0 },
      attachments: [attachment],
    })
    const frame = await frameOf(runOf([pushed]), new Set([contextKey(attachment.id)]))

    expect(frame).toContain('branch: main, 3 files dirty')
  })

  it('opens the attachment when its row is clicked', async () => {
    const attachment = instructions('apps/api/CLAUDE.md')
    const run = runOf([read('apps/api/src/index.ts', [attachment])])
    const setup = await testRender(<Toggling run={run} />, { width: WIDTH, height: HEIGHT })
    await setup.flush()

    try {
      const lines = setup.captureCharFrame().split('\n')
      const row = lines.findIndex((line) => line.includes('⎿ apps/api/CLAUDE.md'))
      expect(row).toBeGreaterThanOrEqual(0)

      await act(async () => {
        await setup.mockMouse.click(4, row)
      })
      await setup.flush()

      expect(setup.captureCharFrame()).toContain('Always run bun test')
    } finally {
      await teardown(setup)
    }
  })

  it('keeps the attachment under its own call inside an opened sentence', async () => {
    const run = runOf([read('a.ts'), read('b.ts', [instructions('CLAUDE.md')])])
    const opened = new Set([`sentence:${run.calls[0]?.callId ?? ''}`])
    const frame = await frameOf(run, opened)

    const rows = frame.split('\n')
    const second = rows.findIndex((row) => row.includes('b.ts'))
    const attachment = rows.findIndex((row) => row.includes('⎿ CLAUDE.md'))

    expect(second).toBeGreaterThanOrEqual(0)
    expect(attachment).toBeGreaterThan(second)
  })
})

function Toggling(props: { run: ToolRun }): React.ReactNode {
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set<string>())
  const handleToggle = useCallback((key: string) => {
    setOpened((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])

  return (
    <ToolRunBlock run={props.run} width={WIDTH} cwd={CWD} opened={opened} onToggle={handleToggle} />
  )
}
