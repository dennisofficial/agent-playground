import { describe, expect, it } from 'bun:test'

import { EAgentStatus } from '@dltech/atlas-core'

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

  it('names the skill it loaded, rather than saying only that a skill was called', () => {
    const loaded = reading(
      aCall({
        name: 'skill',
        input: { name: 'handoff' },
        output: {
          name: 'handoff',
          path: '/Users/dev/.agents/skills/handoff/SKILL.md',
          text: 'one\ntwo\nthree',
        },
      }),
    )

    expect(loaded.line).toBe('Loaded the handoff skill')
    expect(loaded.note).toBe('3 l')
    expect(loaded.metric).toBe(3)
    expect(loaded.detail).toBe(EDetail.File)
  })

  it('names the skill on a refusal too, rather than leaving a bare tool name', () => {
    const refused = reading(
      aCall({
        name: 'skill',
        input: { name: 'tdd' },
        state: ECallState.Failed,
        note: 'no skill is named tdd',
      }),
    )

    expect(refused.line).toBe('Failed skill tdd')
    expect(refused.failed).toBe(true)
    expect(refused.detail).toBe(EDetail.Reason)
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

describe('what a sub-agent call reads as', () => {
  it('names what the child was spawned to do, not the tool that spawned it', () => {
    const spawned = reading(
      aCall({
        name: 'agent_spawn',
        input: { agentType: 'explore', brief: 'find every call site', intent: 'vault audit' },
        output: { agentId: 'thr_child' },
      }),
    )

    expect(spawned.line).toBe('Spawned vault audit')
    expect(spawned.note).toBe('running')
    expect(spawned.klass).toBe(EToolClass.External)
  })

  it('falls back to the agent type when the spawn carried no intent', () => {
    const spawned = reading(
      aCall({ name: 'agent_spawn', input: { agentType: 'reviewer', brief: 'check this' } }),
    )

    expect(spawned.line).toBe('Spawned reviewer')
  })

  it('names the child a message, a resume and a stop were aimed at', () => {
    const said = reading(aCall({ name: 'agent_say', input: { agentId: 'thr_child', text: 'go on' } }))
    const resumed = reading(aCall({ name: 'agent_resume', input: { agentId: 'thr_child' } }))
    const stopped = reading(aCall({ name: 'agent_stop', input: { agentId: 'thr_child' } }))

    expect(said.line).toBe('Messaged thr_child')
    expect(resumed.line).toBe('Resumed thr_child')
    expect(stopped.line).toBe('Stopped thr_child')
  })

  it('says a message to a busy child is waiting rather than running', () => {
    const queued = reading(
      aCall({
        name: 'agent_say',
        input: { agentId: 'thr_child', text: 'go on' },
        output: { agentId: 'thr_child', queued: true },
      }),
    )
    const woken = reading(
      aCall({
        name: 'agent_say',
        input: { agentId: 'thr_child', text: 'go on' },
        output: { agentId: 'thr_child', queued: false },
      }),
    )

    expect(queued.note).toBe('queued')
    expect(woken.note).toBe('running')
  })

  it('never says a stop left the child running', () => {
    const signalled = reading(
      aCall({
        name: 'agent_stop',
        input: { agentId: 'thr_child' },
        output: { agentId: 'thr_child', agentType: 'explore', status: EAgentStatus.Running },
      }),
    )
    const overAlready = reading(
      aCall({
        name: 'agent_stop',
        input: { agentId: 'thr_child' },
        output: { agentId: 'thr_child', agentType: 'explore', status: EAgentStatus.Finished },
      }),
    )

    expect(signalled.note).toBe('stopping')
    expect(overAlready.note).toBe('already done')
  })

  it('counts what a listing found still running, not what it found at all', () => {
    const listed = reading(
      aCall({
        name: 'agent_list',
        output: {
          agents: [
            { agentId: 'a', status: EAgentStatus.Running },
            { agentId: 'b', status: EAgentStatus.Finished },
            { agentId: 'c', status: EAgentStatus.Failed },
          ],
        },
      }),
    )

    expect(listed.line).toBe('Checked on the sub-agents')
    expect(listed.note).toBe('1 running')
    expect(listed.metric).toBe(3)
  })

  it('does not call a listing of finished children running', () => {
    const listed = reading(
      aCall({
        name: 'agent_list',
        output: {
          agents: [
            { agentId: 'a', status: EAgentStatus.Finished },
            { agentId: 'b', status: EAgentStatus.Stopped },
          ],
        },
      }),
    )

    expect(listed.note).toBe('2 ended')
  })

  it('surfaces a child blocked on an approval ahead of the ones still working', () => {
    const listed = reading(
      aCall({
        name: 'agent_list',
        output: {
          agents: [
            { agentId: 'a', status: EAgentStatus.Running },
            { agentId: 'b', status: EAgentStatus.Blocked },
          ],
        },
      }),
    )

    expect(listed.note).toBe('1 blocked')
  })

  it('claims nothing about a listing whose entries carry no status', () => {
    const listed = reading(
      aCall({ name: 'agent_list', output: { agents: [{ agentId: 'a' }, { agentId: 'b' }] } }),
    )

    expect(listed.note).toBe('2 sub-agents')
  })

  it('says none when nothing has been spawned', () => {
    expect(reading(aCall({ name: 'agent_list', output: { agents: [] } })).note).toBe('none')
  })

  it('keeps a single-child spawn reading as the one child it named', () => {
    const one = reading(
      aCall({
        name: 'agent_spawn',
        input: { agentType: 'explore', brief: 'map the tui', intent: 'map the tui app structure' },
      }),
    )

    expect(one.line).toBe('Spawned map the tui app structure')
    expect(one.note).toBe('running')
  })

  it('still names the child while the spawn is only pending', () => {
    const spawning = reading(
      aCall({
        name: 'agent_spawn',
        input: { agentType: 'explore', intent: 'vault audit' },
        state: ECallState.Pending,
      }),
    )

    expect(spawning.line).toBe('agent_spawn')
    expect(spawning.failed).toBe(false)
  })
})

describe('a call the model is still dictating', () => {
  it('names a write and opens onto the file as its content arrives', () => {
    const reading = classify({
      call: aCall({
        name: 'write',
        state: ECallState.Pending,
        input: { path: '/repo/docs/plans/notes.md', content: '# Is the ver' },
      }),
      cwd: CWD,
    })

    expect(reading.klass).toBe(EToolClass.Change)
    expect(reading.line).toBe('Writing docs/plans/notes.md')
    expect(reading.detail).toBe(EDetail.Created)
  })

  it('waits for the content before promising a panel there is nothing to fill', () => {
    const reading = classify({
      call: aCall({
        name: 'write',
        state: ECallState.Pending,
        input: { path: '/repo/docs/plans/notes.md' },
      }),
      cwd: CWD,
    })

    expect(reading.line).toBe('docs/plans/notes.md')
    expect(reading.detail).toBe(EDetail.None)
  })

  it('says the tool name until the arguments say anything at all', () => {
    const reading = classify({ call: aCall({ name: 'write', state: ECallState.Pending }), cwd: CWD })

    expect(reading.line).toBe('write')
    expect(reading.detail).toBe(EDetail.None)
  })

  it('names an edit and opens onto the replacement text as it arrives', () => {
    const reading = classify({
      call: aCall({
        name: 'edit',
        state: ECallState.Pending,
        input: { path: '/repo/src/ui/theme.ts', oldString: 'const a = 1', newString: 'const b' },
      }),
      cwd: CWD,
    })

    expect(reading.klass).toBe(EToolClass.Change)
    expect(reading.line).toBe('Editing src/ui/theme.ts')
    expect(reading.detail).toBe(EDetail.Created)
  })

  it('waits for the replacement text, which streams in after the text it replaces', () => {
    const reading = classify({
      call: aCall({
        name: 'edit',
        state: ECallState.Pending,
        input: { path: '/repo/src/ui/theme.ts', oldString: 'const a = 1' },
      }),
      cwd: CWD,
    })

    expect(reading.line).toBe('src/ui/theme.ts')
    expect(reading.detail).toBe(EDetail.None)
  })

  it('opens a command onto its terminal as the command arrives', () => {
    const reading = classify({
      call: aCall({
        name: 'bash',
        state: ECallState.Pending,
        input: { command: 'bun run build --prod', description: 'Build for production' },
      }),
      cwd: CWD,
    })

    expect(reading.klass).toBe(EToolClass.Command)
    expect(reading.line).toBe('Build for production')
    expect(reading.detail).toBe(EDetail.Terminal)
  })

  it('waits for the command before promising a terminal there is nothing to type into', () => {
    const reading = classify({
      call: aCall({ name: 'bash', state: ECallState.Pending, input: {} }),
      cwd: CWD,
    })

    expect(reading.line).toBe('bash')
    expect(reading.detail).toBe(EDetail.None)
  })
})

describe('the terminal a settled command opens onto', () => {
  it('gives an unrecognised command the terminal rather than a dim dump', () => {
    const shell = reading(aShell({ command: 'nixify --frobnicate', stdout: 'done' }))

    expect(shell.detail).toBe(EDetail.Terminal)
  })

  it('gives a folded read the same terminal when it is opened', () => {
    const shell = reading(aShell({ command: "sed -n '1,60p' src/ui/theme.ts", stdout: 'a\nb' }))

    expect(shell.gather).toBe(EGather.Read)
    expect(shell.detail).toBe(EDetail.Terminal)
  })

  it('gives a named command the terminal too', () => {
    const committed = reading(aShell({ command: "git commit -m 'fix(tui): a thing'" }))

    expect(committed.detail).toBe(EDetail.Terminal)
  })

  it('keeps a test run on its tally, which reads better than its output', () => {
    const tests = reading(aShell({ command: 'bun test', stdout: '\n 41 pass\n 0 fail\n' }))

    expect(tests.detail).toBe(EDetail.Tests)
  })
})
