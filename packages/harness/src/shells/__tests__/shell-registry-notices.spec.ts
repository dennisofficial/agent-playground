import { afterEach, describe, expect, it } from 'bun:test'

import { EKilledBy, EShellStatus as ECoreShellStatus } from '@dltech/atlas-core'

import {
  announced,
  closeRegistries,
  endedDraft,
  job,
  openRegistry,
  settle,
  shellAdapters,
  THREAD,
} from './shell-registry-fixture'

afterEach(closeRegistries)

for (const adapter of shellAdapters) {
  const describeAdapter = adapter.available ? describe : describe.skip

  describeAdapter(`${adapter.name} process adapter`, () => {
    describe('telling the model a background shell finished', () => {
      it('queues one draft naming the shell, how it ended, and what it printed', async () => {
        const { registry } = openRegistry({ adapter })
        const started = registry.start({
          threadId: THREAD,
          command: 'echo hi',
          description: 'Say hi',
        })
        if (!started.ok) throw new Error(started.reason)

        await settle({ registry, shellId: started.snapshot.shellId })
        const drained = registry.drainNotifications({ threadId: THREAD })

        expect(drained).toHaveLength(1)
        expect(endedDraft(drained[0])).toMatchObject({
          type: 'background-shell-ended',
          shellId: 'bash_1',
          command: 'echo hi',
          description: 'Say hi',
          status: ECoreShellStatus.Exited,
          exitCode: 0,
          output: 'hi\n',
          droppedCharacters: 0,
          remainingCharacters: 0,
        })
      })

      it('hands the output over rather than asking the model to go and read it', async () => {
        const { registry } = openRegistry({ adapter })
        const started = registry.start(job({ command: 'echo already-delivered' }))
        if (!started.ok) throw new Error(started.reason)
        await settle({ registry, shellId: started.snapshot.shellId })

        const delivered = endedDraft(registry.drainNotifications({ threadId: THREAD })[0])
        const read = registry.read({ shellId: started.snapshot.shellId, threadId: THREAD })

        expect(delivered.output).toBe('already-delivered\n')
        expect(read.ok && read.delta.text).toBe('')
      })

      it('drains once, so the same ending is never announced twice', async () => {
        const { registry } = openRegistry({ adapter })
        const started = registry.start(job({ command: 'echo hi' }))
        if (!started.ok) throw new Error(started.reason)
        await settle({ registry, shellId: started.snapshot.shellId })

        registry.drainNotifications({ threadId: THREAD })

        expect(registry.drainNotifications({ threadId: THREAD })).toEqual([])
      })

      it('queues nothing while the command is still running', async () => {
        const { registry } = openRegistry({ adapter })
        registry.start(job({ command: 'sleep 30' }))

        await Bun.sleep(100)

        expect(registry.drainNotifications({ threadId: THREAD })).toEqual([])
      })
    })

    describe('waking whoever is listening', () => {
      it('tells a listener the moment a shell ends, so an idle session need not be polled', async () => {
        const { registry } = openRegistry({ adapter })
        let woken = 0
        registry.onNotice(() => {
          woken += 1
        })

        const started = registry.start(job({ command: 'echo hi' }))
        if (!started.ok) throw new Error(started.reason)
        await settle({ registry, shellId: started.snapshot.shellId })

        expect(woken).toBeGreaterThanOrEqual(1)
        expect(registry.pendingNotices({ threadId: THREAD })).toHaveLength(1)
      })

      it('shows an undrained notice without consuming it, so it can be displayed while a turn runs', async () => {
        const { registry } = openRegistry({ adapter })
        const started = registry.start(job({ command: 'echo hi' }))
        if (!started.ok) throw new Error(started.reason)
        await settle({ registry, shellId: started.snapshot.shellId })

        expect(registry.pendingNotices({ threadId: THREAD })).toHaveLength(1)
        expect(registry.pendingNotices({ threadId: THREAD })).toHaveLength(1)
        expect(registry.drainNotifications({ threadId: THREAD })).toHaveLength(1)
        expect(registry.pendingNotices({ threadId: THREAD })).toEqual([])
      })

      it('tells the listener again when a notice leaves the queue, so a display can clear itself', async () => {
        const { registry } = openRegistry({ adapter })
        const started = registry.start(job({ command: 'echo hi' }))
        if (!started.ok) throw new Error(started.reason)
        await settle({ registry, shellId: started.snapshot.shellId })

        let woken = 0
        registry.onNotice(() => {
          woken += 1
        })
        registry.drainNotifications({ threadId: THREAD })

        expect(woken).toBe(1)
      })

      it('stops telling a listener that has unsubscribed', async () => {
        const { registry } = openRegistry({ adapter })
        let woken = 0
        const stop = registry.onNotice(() => {
          woken += 1
        })
        stop()

        const started = registry.start(job({ command: 'echo hi' }))
        if (!started.ok) throw new Error(started.reason)
        await settle({ registry, shellId: started.snapshot.shellId })

        expect(woken).toBe(0)
      })

      it('forgets what is queued, so an ending does not gate-crash a conversation that did not start it', async () => {
        const { registry } = openRegistry({ adapter })
        const started = registry.start(job({ command: 'echo hi' }))
        if (!started.ok) throw new Error(started.reason)
        await settle({ registry, shellId: started.snapshot.shellId })

        registry.forgetNotices({ threadId: THREAD })

        expect(registry.pendingNotices({ threadId: THREAD })).toEqual([])
        expect(registry.drainNotifications({ threadId: THREAD })).toEqual([])
      })
    })

    describe('announcing every ending, whoever caused it', () => {
      it('announces a failure, naming the code', async () => {
        const { registry } = openRegistry({ adapter })
        const started = registry.start(job({ command: 'exit 7' }))
        if (!started.ok) throw new Error(started.reason)
        await settle({ registry, shellId: started.snapshot.shellId })

        expect(endedDraft(registry.drainNotifications({ threadId: THREAD })[0]).exitCode).toBe(7)
      })

      it('announces a shell the developer killed, so the model stops reasoning about a dead server', async () => {
        const { registry } = openRegistry({ adapter })
        const started = registry.start(job({ command: 'sleep 60' }))
        if (!started.ok) throw new Error(started.reason)

        registry.kill({ shellId: started.snapshot.shellId, by: EKilledBy.User, threadId: THREAD })
        await announced({ registry })

        const drained = registry.drainNotifications({ threadId: THREAD })
        expect(drained).toHaveLength(1)
        expect(endedDraft(drained[0]).status).toBe(ECoreShellStatus.Killed)
        expect(endedDraft(drained[0]).killedBy).toBe(EKilledBy.User)
      })

      it('announces a shell killed by teardown rather than suppressing it', async () => {
        const { registry } = openRegistry({ adapter })
        const started = registry.start(job({ command: 'sleep 60' }))
        if (!started.ok) throw new Error(started.reason)

        await registry.closeAll()

        const drained = registry.drainNotifications({ threadId: THREAD })
        expect(drained).toHaveLength(1)
        expect(endedDraft(drained[0]).shellId).toBe(started.snapshot.shellId)
      })

      it('still announces each ending exactly once', async () => {
        const { registry } = openRegistry({ adapter })
        const started = registry.start(job({ command: 'echo hi' }))
        if (!started.ok) throw new Error(started.reason)
        await settle({ registry, shellId: started.snapshot.shellId })

        registry.drainNotifications({ threadId: THREAD })

        expect(registry.drainNotifications({ threadId: THREAD })).toEqual([])
      })
    })

    describe('a kill the model asked for', () => {
      it('hands the ending to the kill call and announces nothing beside it', async () => {
        const { registry } = openRegistry({ adapter })
        const started = registry.start(job({ command: 'echo before; sleep 60' }))
        if (!started.ok) throw new Error(started.reason)
        await Bun.sleep(150)

        const killed = registry.kill({
          shellId: started.snapshot.shellId,
          by: EKilledBy.Model,
          threadId: THREAD,
        })
        if (!killed.ok || killed.settled === undefined) throw new Error('the kill was not claimed')
        const ending = await killed.settled
        await Bun.sleep(100)

        expect(ending.died).toBe(true)
        if (ending.died) {
          expect(ending.snapshot.status).toBe(ECoreShellStatus.Killed)
          expect(ending.snapshot.killedBy).toBe(EKilledBy.Model)
          expect(ending.delta.text).toContain('before')
        }
        expect(registry.pendingNotices({ threadId: THREAD })).toEqual([])
        expect(registry.drainNotifications({ threadId: THREAD })).toEqual([])
      })

      it('answers a second kill of the same shell with the same ending', async () => {
        const { registry } = openRegistry({ adapter })
        const started = registry.start(job({ command: 'sleep 60' }))
        if (!started.ok) throw new Error(started.reason)

        const first = registry.kill({
          shellId: started.snapshot.shellId,
          by: EKilledBy.Model,
          threadId: THREAD,
        })
        const second = registry.kill({
          shellId: started.snapshot.shellId,
          by: EKilledBy.Model,
          threadId: THREAD,
        })
        if (!first.ok || !second.ok) throw new Error('a kill failed')
        if (first.settled === undefined || second.settled === undefined) {
          throw new Error('the kills were not claimed')
        }

        const [one, two] = await Promise.all([first.settled, second.settled])

        expect(one.died).toBe(true)
        expect(two.died).toBe(true)
        expect(registry.drainNotifications({ threadId: THREAD })).toEqual([])
      })

      it('leaves a shell the developer killed to announce itself to a later model kill', async () => {
        const { registry } = openRegistry({ adapter })
        const started = registry.start(job({ command: 'sleep 60' }))
        if (!started.ok) throw new Error(started.reason)

        registry.kill({ shellId: started.snapshot.shellId, by: EKilledBy.User, threadId: THREAD })
        const again = registry.kill({
          shellId: started.snapshot.shellId,
          by: EKilledBy.Model,
          threadId: THREAD,
        })
        if (!again.ok) throw new Error('the second kill failed')
        expect(again.settled).toBeUndefined()

        await announced({ registry })
        const drained = registry.drainNotifications({ threadId: THREAD })
        expect(drained).toHaveLength(1)
        expect(endedDraft(drained[0]).killedBy).toBe(EKilledBy.User)
      })
    })
  })
}
