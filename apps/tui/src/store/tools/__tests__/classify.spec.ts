import { describe, expect, it } from 'bun:test'

import { ECallState } from '../../tool-runs'
import { classify } from '../classify'
import { EDetail, EGather, EToolClass } from '../kinds'
import { aCall, aShell, CWD } from './fixture'

const reading = (call: Parameters<typeof classify>[0]['call']) => classify({ call, cwd: CWD })

describe('what a shell command counts as', () => {
  it('reads a file however the read was spelled', () => {
    const shell = reading(aShell({ command: "sed -n '1,60p' src/ui/theme.ts", stdout: 'a\nb' }))

    expect(shell.klass).toBe(EToolClass.Gathered)
    expect(shell.gather).toBe(EGather.Read)
  })

  it('searches when the line greps, even behind an echo', () => {
    const shell = reading(
      aShell({ command: 'echo "=== hits ===" && grep -rn useClickRegion src', stdout: 'x' }),
    )

    expect(shell.gather).toBe(EGather.Search)
  })

  it('takes the EARLIEST recognised stage, so a trailing wc does not outrank a leading ls', () => {
    const shell = reading(aShell({ command: 'ls docs && wc -l docs/*.md', stdout: 'x' }))

    expect(shell.gather).toBe(EGather.List)
  })

  it('falls back to a plain command when it recognises nothing', () => {
    expect(reading(aShell({ command: 'nixify --frobnicate' })).gather).toBe(EGather.Run)
  })

  it('ignores the cd it was prefixed with', () => {
    const shell = reading(aShell({ command: 'cd /repo/apps/tui && cat CLAUDE.md', stdout: 'a' }))

    expect(shell.gather).toBe(EGather.Read)
  })
})

describe('the commands worth naming', () => {
  it('reads a test tally out of the output', () => {
    const tests = reading(aShell({ command: 'bun test', stdout: '\n 1761 pass\n 0 fail\n' }))

    expect(tests.klass).toBe(EToolClass.Command)
    expect(tests.line).toBe('Tests — 1,761 pass')
    expect(tests.note).toBe('green')
    expect(tests.detail).toBe(EDetail.Tests)
  })

  it('says how many failed when any did', () => {
    const tests = reading(aShell({ command: 'bun test', stdout: '\n 12 pass\n 3 fail\n' }))

    expect(tests.line).toBe('Tests — 12 pass, 3 fail')
    expect(tests.note).toBe('failed')
  })

  it('calls a clean typecheck clean', () => {
    expect(reading(aShell({ command: 'bunx tsc --noEmit' })).line).toBe('Typecheck clean')
  })

  it('counts the errors when a typecheck is not', () => {
    const failed = reading(
      aShell({
        command: 'bunx tsc --noEmit',
        stdout: 'a.ts(1,1): error TS2339: x\nb.ts(2,2): error TS2345: y',
        exitCode: 2,
      }),
    )

    expect(failed.line).toBe('Typecheck — 2 errors')
  })

  it('names where a push went', () => {
    expect(reading(aShell({ command: 'git push origin main' })).line).toBe('Pushed to origin/main')
  })

  it('quotes what a commit said', () => {
    expect(reading(aShell({ command: "git commit -m 'fix(tui): a thing'" })).line).toContain(
      'fix(tui): a thing',
    )
  })

  it('prefers the model’s description to the command it describes', () => {
    const shell = reading(
      aShell({
        command: "python3 - <<'PY'\nimport pathlib\nPY",
        description: 'Rename wide to roomy',
      }),
    )

    expect(shell.line).toBe('Rename wide to roomy')
  })
})

describe('the tools that are not bash', () => {
  it('gives a read its path in a list and a sentence on its own', () => {
    const read = reading(
      aCall({ name: 'read', input: { path: `${CWD}/src/ui/theme.ts` }, output: { lines: 210 } }),
    )

    expect(read.line).toBe('src/ui/theme.ts')
    expect(read.alone).toBe('Read src/ui/theme.ts')
    expect(read.note).toBe('210 l')
    expect(read.metric).toBe(210)
    expect(read.detail).toBe(EDetail.File)
  })

  it('counts a grep in matches', () => {
    const grep = reading(
      aCall({ name: 'grep', input: { pattern: 'useClickRegion' }, output: { matches: ['a', 'b'] } }),
    )

    expect(grep.gather).toBe(EGather.Search)
    expect(grep.note).toBe('2 matches')
  })

  it('takes an edit out of the sentence and shows its diff', () => {
    const edit = reading(
      aCall({
        name: 'edit',
        output: {
          path: `${CWD}/src/a.ts`,
          diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n one\n+two\n',
        },
      }),
    )

    expect(edit.klass).toBe(EToolClass.Change)
    expect(edit.line).toBe('Edited src/a.ts')
    expect(edit.note).toBe('+1 −0')
    expect(edit.detail).toBe(EDetail.Diff)
  })

  it('says a write created rather than wrote when it did', () => {
    const write = reading(
      aCall({ name: 'write', output: { path: `${CWD}/src/new.ts`, created: true, bytes: 58 } }),
    )

    expect(write.line).toBe('Created src/new.ts')
    expect(write.note).toBe('new')
  })

  it('marks a shell nobody has heard from as quiet rather than as zero lines', () => {
    const watch = reading(aCall({ name: 'shell_output', input: { shellId: 'bash_1' }, output: {} }))

    expect(watch.gather).toBe(EGather.Watch)
    expect(watch.note).toBe('quiet')
  })

  it('gives an MCP tool its own line under its own name', () => {
    const external = reading(aCall({ name: 'mcp__linear__save_issue' }))

    expect(external.klass).toBe(EToolClass.External)
    expect(external.line).toBe('Called save_issue')
  })

  it('says what a denial refused, and refuses to guess a measure', () => {
    const denied = reading(
      aCall({
        name: 'write',
        input: { path: `${CWD}/outside.ts` },
        state: ECallState.Denied,
        note: 'outside the workspace root',
      }),
    )

    expect(denied.line).toBe('Refused write outside.ts')
    expect(denied.note).toBe('denied')
    expect(denied.detail).toBe(EDetail.Reason)
  })

  it('opens a failed call onto the error the model was handed, not an empty panel', () => {
    const broken = reading(
      aCall({
        name: 'read',
        input: { path: `${CWD}/gone.ts` },
        state: ECallState.Failed,
        note: 'no file at /repo/gone.ts',
      }),
    )

    expect(broken.line).toBe('Failed read gone.ts')
    expect(broken.failed).toBe(true)
    expect(broken.detail).toBe(EDetail.Reason)
    expect(broken.metric).toBeNull()
  })

  it('leaves a call still running out of every claim about what it did', () => {
    const pending = reading(aCall({ name: 'read', state: ECallState.Pending }))

    expect(pending.note).toBe('')
    expect(pending.metric).toBeNull()
    expect(pending.detail).toBe(EDetail.None)
  })
})
