import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act, useCallback, useState } from 'react'

import { toCallId } from '@dltech/atlas-core'

import { ECallState, type ToolCall, type ToolRun } from '../../store'
import { glyph } from '../theme'
import { ToolRunBlock } from '../components/blocks/tool-run-block'
import { teardown } from '../markdown/__tests__/harness'

const BULLET = glyph.block

const WIDTH = 100

const HEIGHT = 24

const TALL = 60

const CWD = '/repo'

let ordinal = 0

const call = (args: {
  name: string
  input?: unknown
  output?: unknown
  state?: ECallState
  note?: string
  liveOutput?: string
}): ToolCall => {
  ordinal += 1
  return {
    callId: toCallId(`c${ordinal}`),
    name: args.name,
    input: args.input ?? {},
    output: args.output,
    modelText: '',
    state: args.state ?? ECallState.Ok,
    note: args.note ?? null,
    at: null,
    settledAt: args.state === ECallState.Pending ? null : '2026-08-29T00:00:00.000Z',
    ...(args.liveOutput === undefined ? {} : { liveOutput: args.liveOutput }),
  }
}

const runOf = (calls: readonly ToolCall[]): ToolRun => ({
  key: 'tools:c1',
  openedBy: calls[0]?.callId ?? toCallId('c0'),
  calls,
})

async function frameOf(
  run: ToolRun,
  opened?: ReadonlySet<string>,
  height: number = HEIGHT,
): Promise<string> {
  const setup = await testRender(
    <ToolRunBlock
      run={run}
      width={WIDTH}
      cwd={CWD}
      {...(opened === undefined ? {} : { opened })}
    />,
    { width: WIDTH, height },
  )
  await setup.flush()
  const frame = setup.captureCharFrame()
  await teardown(setup)
  return frame
}

const read = (path: string, lines: number): ToolCall =>
  call({ name: 'read', input: { path: `${CWD}/${path}` }, output: { path: `${CWD}/${path}`, lines } })

describe('a run of tool calls in the transcript', () => {
  it('says what a stretch of gathering added up to', async () => {
    const frame = await frameOf(runOf([read('a.ts', 10), read('b.ts', 20)]))

    expect(frame).toContain('Read 2 files')
    expect(frame).toContain('30 lines')
  })

  it('draws a lone call as itself rather than counting to one', async () => {
    const frame = await frameOf(
      runOf([
        call({
          name: 'bash',
          input: { command: 'bun test', description: 'Wait for the full suite' },
          output: { command: 'bun test', stdout: '', exitCode: 0 },
        }),
      ]),
    )

    expect(frame).toContain('Wait for the full suite')
    expect(frame).not.toContain('ran 1 command')
  })

  it('keeps a named command in the place it actually happened', async () => {
    const frame = await frameOf(
      runOf([
        read('a.ts', 1),
        read('b.ts', 1),
        call({
          name: 'bash',
          input: { command: 'bunx tsc --noEmit' },
          output: { command: 'bunx tsc --noEmit', stdout: '', exitCode: 0 },
        }),
        read('c.ts', 1),
        read('d.ts', 1),
      ]),
    )
    const rows = frame.split('\n').filter((row) => row.trim().length > 0)
    const typecheck = rows.findIndex((row) => row.includes('Typecheck clean'))
    const sentences = rows.flatMap((row, index) => (row.includes('Read 2 files') ? [index] : []))

    expect(sentences).toHaveLength(2)
    expect(sentences[0]).toBeLessThan(typecheck)
    expect(sentences[1]).toBeGreaterThan(typecheck)
  })

  it('marks only the head of a cluster of quiet rows, and every loud one', async () => {
    const quiet = () =>
      call({
        name: 'bash',
        input: { command: 'bunx tsc --noEmit' },
        output: { command: 'bunx tsc --noEmit', stdout: '', exitCode: 0 },
      })
    const frame = await frameOf(runOf([quiet(), quiet(), quiet()]))
    const marks = frame.split('\n').filter((row) => row.includes(BULLET)).length

    expect(frame).toContain('Typecheck clean × 3')
    expect(marks).toBe(1)

    const mixed = await frameOf(
      runOf([
        quiet(),
        call({
          name: 'bash',
          input: { command: 'bun test' },
          output: { command: 'bun test', stdout: '\n 1 pass\n 3 fail\n', exitCode: 1 },
        }),
      ]),
    )

    // The second row failed, so it keeps its mark wherever it falls: that glyph is not saying
    // "tool", it is saying "this went wrong".
    expect(mixed.split('\n').filter((row) => row.includes(BULLET))).toHaveLength(2)
  })

  it('shows a change and its diff without being asked', async () => {
    const frame = await frameOf(
      runOf([
        call({
          name: 'edit',
          output: {
            path: `${CWD}/src/a.ts`,
            diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n one\n+const two = 2\n',
          },
        }),
      ]),
    )

    expect(frame).toContain('Edited src/a.ts')
    expect(frame).toContain('const two = 2')
  })

  it('stacks two passes at one file into a single card with a seam between them', async () => {
    const pass = (marker: string, at: number) =>
      call({
        name: 'edit',
        output: {
          path: `${CWD}/src/a.ts`,
          diff: `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -${at},1 +${at},1 @@\n-before\n+${marker}\n`,
        },
      })
    const frame = await frameOf(runOf([pass('newRef', 10), pass('newTarget', 20)]), undefined, TALL)

    expect(frame.split('\n').filter((row) => row.includes('Edited src/a.ts'))).toHaveLength(1)
    expect(frame).toContain('+2 −2')

    const rows = frame.split('\n')
    const first = rows.findIndex((row) => row.includes('newRef'))
    const seam = rows.findIndex((row) => row.includes('⋯'))
    const second = rows.findIndex((row) => row.includes('newTarget'))
    expect(first).toBeGreaterThanOrEqual(0)
    expect(seam).toBeGreaterThan(first)
    expect(second).toBeGreaterThan(seam)
  })

  it('keeps passes at different files in their own cards', async () => {
    const pass = (path: string, marker: string) =>
      call({
        name: 'edit',
        output: {
          path: `${CWD}/${path}`,
          diff: `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n-before\n+${marker}\n`,
        },
      })
    const frame = await frameOf(runOf([pass('src/a.ts', 'newRef'), pass('src/b.ts', 'newTarget')]))

    expect(frame).toContain('Edited src/a.ts')
    expect(frame).toContain('Edited src/b.ts')
  })

  it('shows a created file in the panel a diff would have taken, without the diff colours', async () => {
    const frame = await frameOf(
      runOf([
        call({
          name: 'write',
          input: { path: `${CWD}/src/new.ts`, content: 'export const two = 2\nexport const three = 3\n' },
          output: { path: `${CWD}/src/new.ts`, created: true, bytes: 44 },
        }),
      ]),
    )

    expect(frame).toContain('Created src/new.ts')
    expect(frame).toContain('export const three = 3')
    expect(frame).toContain('2 lines')
    // Nothing is signed: every line of a new file is new, so the `+` column would say it of all of them.
    expect(frame).not.toContain('+ export')
  })

  it('shows the file as it is being dictated, before the write has run', async () => {
    const frame = await frameOf(
      runOf([
        call({
          name: 'write',
          state: ECallState.Pending,
          input: { path: `${CWD}/src/new.ts`, content: 'export const two = 2\nexport const th' },
        }),
      ]),
    )

    expect(frame).toContain('Writing src/new.ts')
    expect(frame).toContain('export const th')
  })

  it('says nothing extra when a write reported no content to show', async () => {
    const frame = await frameOf(
      runOf([
        call({
          name: 'write',
          input: { path: `${CWD}/src/new.ts` },
          output: { path: `${CWD}/src/new.ts`, created: true, bytes: 44 },
        }),
      ]),
    )

    expect(frame).toContain('Created src/new.ts')
  })

  it('shows an edit’s replacement text as it is dictated, before the edit has run', async () => {
    const frame = await frameOf(
      runOf([
        call({
          name: 'edit',
          state: ECallState.Pending,
          input: { path: `${CWD}/src/a.ts`, oldString: 'const one = 1', newString: 'const two' },
        }),
      ]),
    )

    expect(frame).toContain('Editing src/a.ts')
    expect(frame).toContain('const two')
  })

  it('draws an opened command as a terminal — the command above what it printed', async () => {
    const built = call({
      name: 'bash',
      input: { command: 'bun run build', description: 'Build the workspace' },
      output: { command: 'bun run build', stdout: 'bundled 3 entry points', exitCode: 0 },
    })
    const frame = await frameOf(runOf([built]), new Set([built.callId]), TALL)
    const rows = frame.split('\n')

    expect(frame).toContain('Build the workspace')
    const command = rows.findIndex((row) => row.includes('$ bun run build'))
    const printed = rows.findIndex((row) => row.includes('bundled 3 entry points'))
    expect(command).toBeGreaterThanOrEqual(0)
    expect(printed).toBeGreaterThan(command)
  })

  it('soft-wraps a command longer than the panel instead of clipping it', async () => {
    const command = `cd /Users/dev/Developer/atlas/.atlas/worktrees/unified-queue/apps/tui && bun run typecheck && bun test --bail`
    const built = call({
      name: 'bash',
      input: { command, description: 'Check the workspace' },
      output: { command, stdout: '', exitCode: 0 },
    })
    const frame = await frameOf(runOf([built]), new Set([built.callId]), TALL)
    const rows = frame.split('\n')

    const head = rows.findIndex((row) => row.includes('$ cd /Users/dev'))
    expect(head).toBeGreaterThanOrEqual(0)
    const tail = rows.findIndex((row) => row.includes('bun test --bail'))
    expect(tail).toBeGreaterThan(head)
    expect(rows[tail]).not.toContain('…')
  })

  it('strips the colour codes out of what a command printed', async () => {
    const built = call({
      name: 'bash',
      input: { command: 'nix build' },
      output: { command: 'nix build', stdout: '\x1b[31m✗ 3 fail\x1b[0m', exitCode: 1 },
    })
    const frame = await frameOf(runOf([built]), new Set([built.callId]), TALL)

    expect(frame).toContain('✗ 3 fail')
    expect(frame).not.toContain('[31m')
  })

  it('shows a command typing into its terminal before it has run', async () => {
    const frame = await frameOf(
      runOf([
        call({
          name: 'bash',
          state: ECallState.Pending,
          input: { command: 'bun run bu' },
        }),
      ]),
    )

    expect(frame).toContain('$ bun run bu')
  })

  it('shows what a running command has printed so far, read from its tail', async () => {
    const frame = await frameOf(
      runOf([
        call({
          name: 'bash',
          state: ECallState.Pending,
          input: { command: 'bun run build', description: 'Build the workspace' },
          liveOutput: 'compiling 1/3\ncompiling 2/3\ncompiling 3/3',
        }),
      ]),
    )
    const rows = frame.split('\n')

    const command = rows.findIndex((row) => row.includes('$ bun run build'))
    const printed = rows.findIndex((row) => row.includes('compiling 3/3'))
    expect(command).toBeGreaterThanOrEqual(0)
    expect(printed).toBeGreaterThan(command)
  })

  it('keeps only the freshest lines of a running command in view', async () => {
    const printed = Array.from({ length: 20 }, (_unused, index) => `out ${index + 1}`)
    const frame = await frameOf(
      runOf([
        call({
          name: 'bash',
          state: ECallState.Pending,
          input: { command: 'yes' },
          liveOutput: printed.join('\n'),
        }),
      ]),
    )

    expect(frame).toContain('out 20')
    expect(frame).not.toContain('out 1\n')
    expect(frame).not.toContain('… +8 more')
  })

  it('reads a settled command from its durable output, not its old live tail', async () => {
    const ran = call({
      name: 'bash',
      input: { command: 'ls docs' },
      output: { command: 'ls docs', stdout: 'architecture.md', exitCode: 0 },
      liveOutput: 'archite',
    })
    const frame = await frameOf(runOf([ran]), new Set([ran.callId]), TALL)

    expect(frame).toContain('architecture.md')
  })

  it('opens a folded read’s terminal when its row is clicked', async () => {
    const listed = call({
      name: 'bash',
      input: { command: 'ls docs' },
      output: { command: 'ls docs', stdout: 'architecture.md\ncore-contract.md', exitCode: 0 },
    })
    const run = runOf([read('a.ts', 10), listed])

    const shut = await frameOf(run)
    expect(shut).toContain('Read 1 file')
    expect(shut).not.toContain('architecture.md')

    const open = await frameOf(
      run,
      new Set([`sentence:${run.calls[0]?.callId ?? ''}`, listed.callId]),
      TALL,
    )
    expect(open).toContain('$ ls docs')
    expect(open).toContain('architecture.md')
  })

  it('draws a failure as its own row, leaving the sentence to the work that succeeded', async () => {
    const broken = call({
      name: 'bash',
      input: { command: 'nixify' },
      output: { command: 'nixify', stdout: 'nixify: command not found', exitCode: 127 },
    })
    const frame = await frameOf(runOf([read('a.ts', 10), read('b.ts', 20), broken]))

    expect(frame).toContain('Read 2 files')
    expect(frame).toContain('nixify')
    expect(frame).not.toContain('failed')
  })

  it('settles a command back to its row, keeping the terminal for when it is opened', async () => {
    const broken = call({
      name: 'bash',
      input: { command: 'bun run typecheck' },
      output: {
        command: 'bun run typecheck',
        stdout: 'vault-backend.spec.ts(90,66): error TS2769: No overload matches this call.',
        exitCode: 2,
      },
    })
    const run = runOf([broken])

    const shut = await frameOf(run)
    expect(shut).toContain('Typecheck')
    expect(shut).not.toContain('$ bun run typecheck')
    expect(shut).not.toContain('TS2769')

    const open = await frameOf(run, new Set([broken.callId]), TALL)
    expect(open).toContain('$ bun run typecheck')
    expect(open).toContain('TS2769')
  })

  it('keeps a sentence whole when a later stage owns the exit code the clause does not', async () => {
    const passing = call({
      name: 'bash',
      input: { command: 'grep -rn theme src | head -20; cat missing.json' },
      output: {
        command: 'grep -rn theme src | head -20; cat missing.json',
        stdout: 'src/ui/theme.ts:4',
        exitCode: 1,
      },
    })
    const frame = await frameOf(runOf([read('a.ts', 10), passing]))

    expect(frame).toContain('Read 1 file, searched 1 time')
    expect(frame).not.toContain('failed')
  })

  it('keeps a refused call to its line until the row is opened', async () => {
    const refused = call({
      name: 'write',
      input: { path: `${CWD}/outside.ts` },
      state: ECallState.Denied,
      note: 'the path is outside the workspace root',
    })
    const run = runOf([refused])

    const shut = await frameOf(run)
    expect(shut).toContain('Refused write outside.ts')
    expect(shut).not.toContain('outside the workspace root')
    expect(await frameOf(run, new Set([refused.callId]))).toContain('outside the workspace root')
  })

  it('keeps a failed call to its line until the row is opened', async () => {
    const broken = call({
      name: 'read',
      input: { path: `${CWD}/gone.ts` },
      state: ECallState.Failed,
      note: 'no file at /repo/gone.ts',
    })
    const run = runOf([broken])

    const shut = await frameOf(run)
    expect(shut).toContain('Failed read gone.ts')
    expect(shut).not.toContain('no file at /repo/gone.ts')
    expect(await frameOf(run, new Set([broken.callId]))).toContain('no file at /repo/gone.ts')
  })

  it('lists the calls once the sentence is opened, and not before', async () => {
    const run = runOf([read('theme.ts', 1), read('paths.ts', 1)])

    expect(await frameOf(run)).not.toContain('paths.ts')
    expect(await frameOf(run, new Set([`sentence:${run.calls[0]?.callId ?? ''}`]))).toContain(
      'paths.ts',
    )
  })

  it('opens an image read onto what the picture is, not onto its bytes', async () => {
    const shot = call({
      name: 'read',
      input: { path: `${CWD}/docs/shot.png` },
      output: {
        path: `${CWD}/docs/shot.png`,
        mediaType: 'image/png',
        byteLength: 412 * 1024,
        width: 1024,
        height: 768,
        inlined: true,
      },
    })
    const run = runOf([shot])

    const shut = await frameOf(run)
    expect(shut).toContain('Read docs/shot.png')
    expect(shut).toContain('1024\u00d7768')

    const open = await frameOf(run, new Set([shot.callId]))
    expect(open).toContain('docs/shot.png \u00b7 1024\u00d7768 \u00b7 412 KB')
  })

  it('names the skill on its row and opens the skill body as a file block', async () => {
    const loaded = call({
      name: 'skill',
      input: { name: 'handoff' },
      output: {
        name: 'handoff',
        path: '/Users/dev/.agents/skills/handoff/SKILL.md',
        text: '# Handoff\n\nCompact the conversation into a handoff document.',
      },
    })
    const run = runOf([loaded])

    const shut = await frameOf(run)
    expect(shut).toContain('Loaded the handoff skill')
    expect(shut).not.toContain('Called skill')
    expect(shut).not.toContain('Compact the conversation')

    const open = await frameOf(run, new Set([loaded.callId]))
    expect(open).toContain('Compact the conversation')
  })

  it('holds the rest of a created file behind its count until the count is opened', async () => {
    const numbered = Array.from({ length: 24 }, (_unused, index) => `line ${index + 1}`)
    const wrote = call({
      name: 'write',
      input: { path: `${CWD}/spec.md`, content: numbered.join('\n') },
      output: { path: `${CWD}/spec.md`, created: true },
    })
    const run = runOf([wrote])

    const shut = await frameOf(run, undefined, TALL)
    expect(shut).toContain('… +4 more')
    expect(shut).not.toContain('line 24')

    const open = await frameOf(run, new Set([`more:${wrote.callId}`]), TALL)
    expect(open).toContain('line 24')
    expect(open).toContain('… show less')
  })

  it('holds the rest of an opened call output behind its count', async () => {
    const printed = Array.from({ length: 16 }, (_unused, index) => `out ${index + 1}`)
    const ran = call({
      name: 'bash',
      input: { command: 'ls' },
      output: { stdout: printed.join('\n') },
    })
    const run = runOf([ran])

    const shut = await frameOf(run, new Set([ran.callId]), TALL)
    expect(shut).toContain('… +4 more')
    expect(shut).not.toContain('out 16')

    const open = await frameOf(run, new Set([ran.callId, `more:${ran.callId}`]), TALL)
    expect(open).toContain('out 16')
    expect(open).toContain('… show less')
  })

  it('opens the rest of a created file when the count itself is clicked', async () => {
    const numbered = Array.from({ length: 24 }, (_unused, index) => `line ${index + 1}`)
    const wrote = call({
      name: 'write',
      input: { path: `${CWD}/spec.md`, content: numbered.join('\n') },
      output: { path: `${CWD}/spec.md`, created: true },
    })
    const setup = await testRender(<Toggling run={runOf([wrote])} />, {
      width: WIDTH,
      height: TALL,
    })
    await setup.flush()

    try {
      const lines = setup.captureCharFrame().split('\n')
      const row = lines.findIndex((line) => line.includes('+4 more'))
      const column = lines[row]?.indexOf('…') ?? -1
      expect(column).toBeGreaterThanOrEqual(0)
      expect(setup.captureCharFrame()).not.toContain('line 24')

      await act(async () => {
        await setup.mockMouse.click(column, row)
      })
      await setup.flush()

      expect(setup.captureCharFrame()).toContain('line 24')
    } finally {
      await teardown(setup)
    }
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
    <ToolRunBlock
      run={props.run}
      width={WIDTH}
      cwd={CWD}
      opened={opened}
      onToggle={handleToggle}
    />
  )
}
