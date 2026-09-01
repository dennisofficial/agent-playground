import { afterEach, describe, expect, it } from 'bun:test'

import { EShellStatus } from '../background-shell'
import { PROMPT_SETTLE_MS } from '../shell-registry'
import {
  awaitingInputDraft,
  awaitingInputOf,
  closeRegistries,
  job,
  openRegistry,
  settle,
  THREAD,
} from './shell-registry-fixture'

afterEach(closeRegistries)

describe('noticing a background shell stuck on a prompt', () => {
  it('reports a running shell whose last line looks like a question as awaiting input', async () => {
    const { registry } = openRegistry()
    const started = registry.start(job({ command: `printf 'Overwrite? (y/n) '; sleep 30` }))
    if (!started.ok) throw new Error(started.reason)

    expect(await awaitingInputOf({ registry, shellId: started.snapshot.shellId })).toBe(true)
  })

  it('says nothing of the sort about a shell printing ordinary progress', async () => {
    const { registry } = openRegistry()
    const started = registry.start(job({ command: `echo 'compiled 12 modules'; sleep 30` }))
    if (!started.ok) throw new Error(started.reason)
    await Bun.sleep(300)

    const snapshot = registry
      .list({ threadId: THREAD })
      .find((entry) => entry.shellId === started.snapshot.shellId)

    expect(snapshot?.awaitingInput).toBe(false)
  })

  it('announces a shell that stopped to ask, so the model can answer it', async () => {
    const { registry } = openRegistry()
    const started = registry.start(job({ command: `printf 'Password: '; sleep 30` }))
    if (!started.ok) throw new Error(started.reason)
    expect(await awaitingInputOf({ registry, shellId: started.snapshot.shellId })).toBe(true)

    const drained = registry.drainNotifications({ threadId: THREAD })

    expect(drained).toHaveLength(1)
    expect(awaitingInputDraft(drained[0])).toMatchObject({
      type: 'background-shell-awaiting-input',
      shellId: 'bash_1',
      command: `printf 'Password: '; sleep 30`,
      description: 'Run a background job',
      output: 'Password: ',
      droppedCharacters: 0,
      remainingCharacters: 0,
    })
  })

  it('queues nothing for a slow command, so it is left alone however long it runs', async () => {
    const { registry } = openRegistry()
    const started = registry.start(job({ command: `printf 'compiled 12 modules'; sleep 30` }))
    if (!started.ok) throw new Error(started.reason)
    await Bun.sleep(PROMPT_SETTLE_MS + 500)

    const snapshot = registry
      .list({ threadId: THREAD })
      .find((entry) => entry.shellId === started.snapshot.shellId)

    expect(snapshot?.status).toBe(EShellStatus.Running)
    expect(snapshot?.awaitingInput).toBe(false)
    expect(registry.drainNotifications({ threadId: THREAD })).toEqual([])
  })

  it('stops claiming it once the shell has ended', async () => {
    const { registry } = openRegistry()
    const started = registry.start(job({ command: `printf 'Continue? (y/n) '` }))
    if (!started.ok) throw new Error(started.reason)
    await settle({ registry, shellId: started.snapshot.shellId })

    const snapshot = registry
      .list({ threadId: THREAD })
      .find((entry) => entry.shellId === started.snapshot.shellId)

    expect(snapshot?.awaitingInput).toBe(false)
  })
})
