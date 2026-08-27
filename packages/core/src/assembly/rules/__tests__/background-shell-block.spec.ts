import { describe, expect, it } from 'bun:test'

import { EShellStatus } from '../../../shells/status'
import { backgroundShellBlock } from '../background-shell-block'

const ended = (over: Partial<Parameters<typeof backgroundShellBlock>[0]> = {}) =>
  ({
    id: 'evt_1',
    seq: 1,
    threadId: 'br_1',
    runId: 'run_1',
    depth: 0,
    at: '2026-08-27T12:00:00.000Z',
    type: 'background-shell-ended',
    shellId: 'bash_1',
    command: 'bun test',
    status: EShellStatus.Exited,
    exitCode: 0,
    output: '261 pass, 0 fail\n',
    droppedCharacters: 0,
    remainingCharacters: 0,
    ...over,
  }) as Parameters<typeof backgroundShellBlock>[0]

describe('handing a finished background shell to the model', () => {
  it('names the shell, how it ended, and hands over what it printed', () => {
    const block = backgroundShellBlock(ended({ description: 'Run full TUI suite' }))

    expect(block).toContain('bash_1')
    expect(block).toContain('"Run full TUI suite"')
    expect(block).toContain('`bun test`')
    expect(block).toContain('finished successfully')
    expect(block).toContain('261 pass, 0 fail')
  })

  it('never tells the model to go and read what it was just given', () => {
    const block = backgroundShellBlock(ended())

    expect(block).not.toContain('shell_output')
  })

  it('points at shell_output only when output is genuinely still waiting', () => {
    const block = backgroundShellBlock(ended({ remainingCharacters: 4_096 }))

    expect(block).toContain('4096 more characters')
    expect(block).toContain('shell_output({ shellId: "bash_1" })')
  })

  it('falls back to the command when the shell was never named', () => {
    expect(backgroundShellBlock(ended())).toContain('`bun test`')
  })

  it('says a kill was a kill rather than an exit', () => {
    const block = backgroundShellBlock(
      ended({ status: EShellStatus.Killed, exitCode: undefined, output: '' }),
    )

    expect(block).toContain('was killed')
    expect(block).toContain('It printed nothing.')
  })

  it('names a failing exit code', () => {
    expect(backgroundShellBlock(ended({ exitCode: 2 }))).toContain('failed with exit code 2')
  })

  it('admits output lost to a shell printing faster than it was read', () => {
    const block = backgroundShellBlock(ended({ droppedCharacters: 900 }))

    expect(block).toContain('900 characters were lost')
  })

  it('wraps the block so the model can tell it from something a human typed', () => {
    const block = backgroundShellBlock(ended())

    expect(block.startsWith('<background-shell-ended>')).toBe(true)
    expect(block.endsWith('</background-shell-ended>')).toBe(true)
  })
})
