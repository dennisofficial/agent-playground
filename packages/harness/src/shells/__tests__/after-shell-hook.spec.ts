import { afterEach, describe, expect, it } from 'bun:test'

import {
  AfterShellHook,
  EKilledBy,
  EShellStatus,
  EStage,
  type AfterShell,
  type EndedShell,
  type HookOrder,
  type ThreadId,
} from '@dltech/atlas-core'

import { HookChain, type HookChainSource } from '../../hooks/registry'
import { AFTER_SHELL_BUDGET_MS, afterShellDrafts } from '../after-shell'
import {
  announced,
  closeRegistries,
  ELSEWHERE,
  endedDraft,
  job,
  openRegistry,
  settle,
  THREAD,
} from './shell-registry-fixture'

class ObservingHook extends AfterShellHook {
  constructor(
    readonly name: string,
    readonly order: HookOrder,
    readonly run: AfterShell,
  ) {
    super()
  }
}

const observe = (args: {
  name: string
  seen: { threadId: ThreadId; shell: EndedShell }[]
}): ObservingHook =>
  new ObservingHook(args.name, { stage: EStage.Observe, nudge: 0 }, async (fired) => {
    args.seen.push(fired)
    return {}
  })

const chainOf = (hooks: readonly AfterShellHook[]): HookChainSource => {
  const chain = new HookChain({ afterShell: hooks })
  return () => chain
}

afterEach(closeRegistries)

describe('the budget an after-shell hook is given', () => {
  const chain = (run: AfterShell): HookChainSource =>
    chainOf([new ObservingHook('bounded', { stage: EStage.Observe, nudge: 0 }, run)])

  const shell: EndedShell = {
    shellId: 'bash_1',
    command: 'git push origin main',
    status: EShellStatus.Exited,
    exitCode: 0,
  }

  it('gives up the drafts of a hook that never settles, and settles anyway', async () => {
    const drafts = await afterShellDrafts({
      hooks: chain(() => new Promise(() => {})),
      threadId: THREAD,
      shell,
      budgetMs: 25,
    })

    expect(drafts).toEqual([])
  })

  it('delivers the drafts of a hook that answers inside the budget', async () => {
    const drafts = await afterShellDrafts({
      hooks: chain(async () => {
        await Bun.sleep(10)
        return { additionalContext: 'the checks are green' }
      }),
      threadId: THREAD,
      shell,
      budgetMs: 500,
    })

    expect(drafts).toHaveLength(1)
  })

  it('swallows a rejection that arrives long after the budget expired', async () => {
    const drafts = await afterShellDrafts({
      hooks: chain(
        () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('the poller gave up')), 40).unref?.()
          }),
      ),
      threadId: THREAD,
      shell,
      budgetMs: 10,
    })

    expect(drafts).toEqual([])
    await Bun.sleep(80)
  })
})

describe('the after-shell phase, fired by the shell registry', () => {
  it('runs when a shell exits, naming the shell and the thread that started it', async () => {
    const seen: { threadId: ThreadId; shell: EndedShell }[] = []
    const { registry } = openRegistry({ hooks: chainOf([observe({ name: 'watch', seen })]) })

    const started = registry.start(job({ command: 'echo pushed' }))
    if (!started.ok) throw new Error(started.reason)
    await settle({ registry, shellId: started.snapshot.shellId })
    await announced({ registry })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.threadId).toBe(THREAD)
    expect(seen[0]?.shell.shellId).toBe(started.snapshot.shellId)
    expect(seen[0]?.shell.command).toBe('echo pushed')
    expect(seen[0]?.shell.status).toBe(EShellStatus.Exited)
    expect(seen[0]?.shell.exitCode).toBe(0)
  })

  it('runs for a killed shell, and says who killed it', async () => {
    const seen: { threadId: ThreadId; shell: EndedShell }[] = []
    const { registry } = openRegistry({ hooks: chainOf([observe({ name: 'watch', seen })]) })

    const started = registry.start(job({ command: 'sleep 30' }))
    if (!started.ok) throw new Error(started.reason)
    registry.kill({ shellId: started.snapshot.shellId, by: EKilledBy.Model, threadId: THREAD })
    await announced({ registry })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.shell.status).toBe(EShellStatus.Killed)
    expect(seen[0]?.shell.killedBy).toBe(EKilledBy.Model)
  })

  it('runs once per shell, however often the ending is looked at', async () => {
    const seen: { threadId: ThreadId; shell: EndedShell }[] = []
    const { registry } = openRegistry({ hooks: chainOf([observe({ name: 'watch', seen })]) })

    const started = registry.start(job({ command: 'echo once' }))
    if (!started.ok) throw new Error(started.reason)
    await settle({ registry, shellId: started.snapshot.shellId })
    await announced({ registry })

    registry.drainNotifications({ threadId: THREAD })
    registry.list({ threadId: THREAD })
    await Bun.sleep(100)

    expect(seen).toHaveLength(1)
  })

  it('is told the thread that started the shell, not whoever is on screen', async () => {
    const seen: { threadId: ThreadId; shell: EndedShell }[] = []
    const { registry } = openRegistry({ hooks: chainOf([observe({ name: 'watch', seen })]) })

    const started = registry.start(job({ command: 'echo elsewhere', threadId: ELSEWHERE }))
    if (!started.ok) throw new Error(started.reason)
    await settle({ registry, shellId: started.snapshot.shellId, threadId: ELSEWHERE })
    await announced({ registry, threadId: ELSEWHERE })

    expect(seen.map((one) => one.threadId)).toEqual([ELSEWHERE])
    expect(registry.pendingNotices({ threadId: THREAD })).toEqual([])
  })

  it('hands its drafts over with the ending, because nothing else would deliver them', async () => {
    const started = 'polling ci for the push'
    const hook = new ObservingHook(
      'poll-ci',
      { stage: EStage.Observe, nudge: 0 },
      async () => ({ additionalContext: started }),
    )
    const { registry } = openRegistry({ hooks: chainOf([hook]) })

    const shell = registry.start(job({ command: 'echo pushed' }))
    if (!shell.ok) throw new Error(shell.reason)
    await settle({ registry, shellId: shell.snapshot.shellId })
    await announced({ registry })

    const drained = registry.drainNotifications({ threadId: THREAD })

    expect(endedDraft(drained[0]).shellId).toBe(shell.snapshot.shellId)
    expect(drained[1]).toEqual({
      type: 'context-loaded',
      slot: 'poll-ci',
      key: 'additional-context',
      content: started,
    })
  })

  it('keeps the ending when a hook throws, because a dying process has nowhere to report it', async () => {
    const hook = new ObservingHook('throws', { stage: EStage.Observe, nudge: 0 }, async () => {
      throw new Error('the poller could not reach the forge')
    })
    const { registry } = openRegistry({ hooks: chainOf([hook]) })

    const shell = registry.start(job({ command: 'echo pushed' }))
    if (!shell.ok) throw new Error(shell.reason)
    await settle({ registry, shellId: shell.snapshot.shellId })
    await announced({ registry })

    const drained = registry.drainNotifications({ threadId: THREAD })

    expect(drained).toHaveLength(1)
    expect(endedDraft(drained[0]).shellId).toBe(shell.snapshot.shellId)
  })

  it('queues the ending and lets teardown return when a hook never settles', async () => {
    const hook = new ObservingHook(
      'never-settles',
      { stage: EStage.Observe, nudge: 0 },
      () => new Promise(() => {}),
    )
    const { registry } = openRegistry({ hooks: chainOf([hook]) })

    const shell = registry.start(job({ command: 'echo pushed' }))
    if (!shell.ok) throw new Error(shell.reason)
    await settle({ registry, shellId: shell.snapshot.shellId })

    const closing = Date.now()
    await registry.closeAll()

    expect(Date.now() - closing).toBeLessThan(AFTER_SHELL_BUDGET_MS * 2)
    const drained = registry.drainNotifications({ threadId: THREAD })
    expect(drained).toHaveLength(1)
    expect(endedDraft(drained[0]).shellId).toBe(shell.snapshot.shellId)
  }, AFTER_SHELL_BUDGET_MS * 3)

  it('has run before teardown returns, so the close path can still record what it produced', async () => {
    const hook = new ObservingHook(
      'poll-ci',
      { stage: EStage.Observe, nudge: 0 },
      async () => ({ additionalContext: 'the dev server went with the session' }),
    )
    const { registry } = openRegistry({ hooks: chainOf([hook]) })

    const shell = registry.start(job({ command: 'sleep 30' }))
    if (!shell.ok) throw new Error(shell.reason)

    await registry.closeAll()

    expect(registry.threadsAwaitingNotice()).toEqual([THREAD])
    expect(registry.drainNotifications({ threadId: THREAD })).toHaveLength(2)
  })
})
