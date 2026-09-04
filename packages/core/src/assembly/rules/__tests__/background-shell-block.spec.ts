import { describe, expect, it } from 'bun:test'

import { EKilledBy, EShellStatus } from '../../../shells/status'
import {
  backgroundShellBlock,
  backgroundShellMatchedBlock,
  backgroundShellStillRunningBlock,
} from '../background-shell-block'

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

  it('says the user was the one who stopped it, and that nothing is wrong', () => {
    const block = backgroundShellBlock(
      ended({ status: EShellStatus.Killed, killedBy: EKilledBy.User, exitCode: undefined, output: '' }),
    )

    expect(block).toContain('was killed by the user')
    expect(block).toContain('do not restart it')
  })

  it('tells the model when the kill was its own, so it does not read it as interference', () => {
    const block = backgroundShellBlock(
      ended({ status: EShellStatus.Killed, killedBy: EKilledBy.Model, exitCode: undefined }),
    )

    expect(block).toContain('was killed at your request')
    expect(block).not.toContain('do not restart it')
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

const matched = (over: Partial<Parameters<typeof backgroundShellMatchedBlock>[0]> = {}) =>
  ({
    id: 'evt_2',
    seq: 2,
    threadId: 'br_1',
    runId: 'run_1',
    depth: 0,
    at: '2026-08-27T12:00:00.000Z',
    type: 'background-shell-matched',
    shellId: 'bash_1',
    command: 'bun test',
    pattern: '(fail|error)',
    lines: '12 fail\n',
    matchCount: 1,
    ...over,
  }) as Parameters<typeof backgroundShellMatchedBlock>[0]

describe('handing a running background shell watch match to the model', () => {
  it('names the shell and hands over the lines that matched', () => {
    const block = backgroundShellMatchedBlock(
      matched({ description: 'Run full TUI suite', lines: '12 fail\n13 fail\n', matchCount: 2 }),
    )

    expect(block).toContain('bash_1')
    expect(block).toContain('"Run full TUI suite"')
    expect(block).toContain('`bun test`')
    expect(block).toContain('2 lines')
    expect(block).toContain('12 fail')
    expect(block).toContain('13 fail')
  })

  it('counts a lone match in the singular', () => {
    expect(backgroundShellMatchedBlock(matched())).toContain('1 line')
  })

  it('says the shell is still running, so a match does not read as an ending', () => {
    const block = backgroundShellMatchedBlock(matched())

    expect(block).toContain('still running')
    expect(block).toContain('has not ended')
    expect(block).not.toContain('shell_output')
  })

  it('says the lines are only what the pattern covers, so silence proves nothing', () => {
    const block = backgroundShellMatchedBlock(matched())

    expect(block).toContain('/(fail|error)/')
    expect(block).toContain('Silence from this watch is not evidence')
  })

  it('says a disarmed watch stopped and the shell did not', () => {
    const block = backgroundShellMatchedBlock(matched({ watchDisarmed: true }))

    expect(block).toContain('The watch has stopped')
    expect(block).toContain('The shell itself did NOT stop')
    expect(block).toContain('its ending will still arrive')
  })

  it('renders the disarm notice even with no lines to show', () => {
    const block = backgroundShellMatchedBlock(
      matched({ watchDisarmed: true, lines: '', matchCount: 200 }),
    )

    expect(block).toContain('It carried no lines with it.')
    expect(block).toContain('The watch has stopped')
    expect(block).toContain('The shell itself did NOT stop')
    expect(block).toContain('still running')
  })

  it('says nothing about a disarmed watch while the watch is still armed', () => {
    expect(backgroundShellMatchedBlock(matched())).not.toContain('The watch has stopped')
  })

  it('wraps the block so the model can tell it from something a human typed', () => {
    const block = backgroundShellMatchedBlock(matched())

    expect(block.startsWith('<background-shell-matched>')).toBe(true)
    expect(block.endsWith('</background-shell-matched>')).toBe(true)
  })
})

const stillRunning = (over: Partial<Parameters<typeof backgroundShellStillRunningBlock>[0]> = {}) =>
  ({
    id: 'evt_3',
    seq: 3,
    threadId: 'br_1',
    runId: 'run_1',
    depth: 0,
    at: '2026-08-27T12:13:26.000Z',
    type: 'background-shell-still-running',
    shellId: 'bash_27',
    command: 'bash /tmp/cubic-poll-371.sh 43',
    runningForMs: 806_000,
    silentForMs: 26_000,
    checkInMs: 300_000,
    tail: '39 pending no-check\n40 pending no-check',
    ...over,
  }) as Parameters<typeof backgroundShellStillRunningBlock>[0]

describe('checking in on a background shell that has not ended', () => {
  it('names the shell and how long it has been up', () => {
    const block = backgroundShellStillRunningBlock(
      stillRunning({ description: 'Poll cubic round on head 43db0f7c' }),
    )

    expect(block).toContain('bash_27')
    expect(block).toContain('"Poll cubic round on head 43db0f7c"')
    expect(block).toContain('`bash /tmp/cubic-poll-371.sh 43`')
    expect(block).toContain('running for 13m 26s')
  })

  it('reads as a check-in rather than an ending, so nobody treats the job as done', () => {
    const block = backgroundShellStillRunningBlock(stillRunning())

    expect(block).toContain('has not ended')
    expect(block).toContain('scheduled check-in, not an ending')
    expect(block).toContain('when it ends you will be told')
  })

  it('shows a chatty shell its own latest output, so a stuck poll loop is visible', () => {
    const block = backgroundShellStillRunningBlock(stillRunning())

    expect(block).toContain('It last printed 26s ago.')
    expect(block).toContain('40 pending no-check')
  })

  it('says a quiet shell has printed nothing, and shows no tail section', () => {
    const block = backgroundShellStillRunningBlock(
      stillRunning({ silentForMs: 806_000, tail: '' }),
    )

    expect(block).toContain('It has printed nothing in all that time.')
    expect(block).not.toContain('most recent output')
  })

  it('names the three ways out, including service_start for something meant to stay up', () => {
    const block = backgroundShellStillRunningBlock(stillRunning())

    expect(block).toContain('shell_output({ shellId: "bash_27" })')
    expect(block).toContain('shell_kill({ shellId: "bash_27" })')
    expect(block).toContain('service_start')
    expect(block).toContain('do nothing')
  })

  it('says the check-ins repeat and on what cadence', () => {
    expect(backgroundShellStillRunningBlock(stillRunning())).toContain('repeat every 5m 0s')
  })

  it('wraps the block so the model can tell it from something a human typed', () => {
    const block = backgroundShellStillRunningBlock(stillRunning())

    expect(block.startsWith('<background-shell-still-running>')).toBe(true)
    expect(block.endsWith('</background-shell-still-running>')).toBe(true)
  })
})
