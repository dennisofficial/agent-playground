import { describe, expect, it } from 'bun:test'

import { toThreadId } from '../../events/ids'
import { EKilledBy, EShellStatus, type EndedShell } from '../../shells/status'
import { EHookPhase, type AfterShell, type AfterShellHook } from '../hooks'
import { EStage, orderHooks } from '../order'
import { hookOutcomeDrafts } from '../outcome'

const pushed: EndedShell = {
  shellId: 'bash_1',
  command: 'git push origin main',
  description: 'Push the branch',
  status: EShellStatus.Exited,
  exitCode: 0,
}

const killed: EndedShell = {
  shellId: 'bash_2',
  command: 'bun run dev',
  description: 'Dev server',
  status: EShellStatus.Killed,
  killedBy: EKilledBy.SessionEnd,
}

describe('the after-shell phase', () => {
  it('is named beside the phases the loop drives', () => {
    expect(String(EHookPhase.AfterShell)).toBe('after-shell')
    expect(Object.values(EHookPhase)).toContain(EHookPhase.AfterShell)
  })

  it('carries the shell that ended and the thread that started it', async () => {
    const seen: EndedShell[] = []

    const pollCi: AfterShell = async ({ shell }) => {
      seen.push(shell)
      return { additionalContext: `watching ci for ${shell.command}` }
    }

    const outcome = await pollCi({ threadId: toThreadId('thread-1'), shell: pushed })

    expect(seen).toEqual([pushed])
    expect(hookOutcomeDrafts({ hookName: 'poll-ci', outcome })).toEqual([
      {
        type: 'context-loaded',
        slot: 'poll-ci',
        key: 'additional-context',
        content: 'watching ci for git push origin main',
      },
    ])
  })

  it('tells a killed ending apart from a clean one without asking the harness', async () => {
    const endings: string[] = []

    const record: AfterShell = async ({ shell }) => {
      endings.push(`${shell.status}:${shell.killedBy ?? shell.exitCode}`)
      return {}
    }

    const threadId = toThreadId('thread-1')
    await record({ threadId, shell: pushed })
    await record({ threadId, shell: killed })

    expect(endings).toEqual(['exited:0', 'killed:session-end'])
  })

  it('is ordered by stage and nudge like every other phase', () => {
    const hook = (name: string, stage: EStage, nudge: number): AfterShellHook => ({
      name,
      order: { stage, nudge },
      run: async () => ({}),
    })

    const ordered = orderHooks([
      hook('watch', EStage.Observe, 0),
      hook('deny', EStage.Guard, 10),
      hook('decide', EStage.Policy, 0),
      hook('bar', EStage.Guard, 0),
      hook('foo', EStage.Guard, 0),
    ])

    expect(ordered.map((one) => one.name)).toEqual(['bar', 'foo', 'deny', 'decide', 'watch'])
  })
})
