import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { EShellStatus as ECoreShellStatus, type ClockPort, type EventDraft, type EventOfType } from '@dltech/atlas-core'

import { EShellStatus } from '../background-shell'
import { BunShellRegistry, type ShellRegistryPort } from '../shell-registry'
import { toShellId } from '../shell-id'

class SteppableClock implements ClockPort {
  private millis = Date.parse('2026-08-27T12:00:00.000Z')

  now(): string {
    return new Date(this.millis).toISOString()
  }

  advance(by: number): void {
    this.millis += by
  }
}

type EndedDraft = Omit<EventOfType<'background-shell-ended'>, keyof { id: 0; seq: 0; threadId: 0; runId: 0; depth: 0; at: 0 }>

function endedDraft(draft: EventDraft | undefined): EndedDraft {
  if (draft?.type !== 'background-shell-ended') {
    throw new Error(`expected a background-shell-ended draft, got ${draft?.type ?? 'nothing'}`)
  }
  return draft
}

const opened: { registry: ShellRegistryPort; root: string }[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.registry.closeAll()
    rmSync(entry.root, { recursive: true, force: true })
  }
})

function openRegistry(): { registry: BunShellRegistry; clock: SteppableClock; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'atlas-shells-'))
  const clock = new SteppableClock()
  const registry = new BunShellRegistry(root, clock)
  opened.push({ registry, root })
  return { registry, clock, root }
}

async function settle(registry: ShellRegistryPort, shellId: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const snapshot = registry.list().find((entry) => entry.shellId === shellId)
    if (snapshot !== undefined && snapshot.status !== EShellStatus.Running) return
    await Bun.sleep(25)
  }
  throw new Error(`background shell ${shellId} never left running`)
}

/**
 * A kill flips the status synchronously but the ending is announced when the process is reaped, so
 * waiting on the status is not waiting on the notice.
 */
async function announced(registry: ShellRegistryPort): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (registry.pendingNotices().length > 0) return
    await Bun.sleep(25)
  }
  throw new Error('no background shell ending was ever announced')
}

describe('starting a shell in the background', () => {
  it('returns a shell id at once rather than waiting for the command', () => {
    const { registry } = openRegistry()

    const started = registry.start({ command: 'sleep 30' })

    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.snapshot.shellId).toBe(toShellId('bash_1'))
    expect(started.snapshot.status).toBe(EShellStatus.Running)
  })

  it('numbers each shell so two are told apart', () => {
    const { registry } = openRegistry()

    const first = registry.start({ command: 'sleep 30' })
    const second = registry.start({ command: 'sleep 30' })

    expect(first.ok && first.snapshot.shellId).toBe(toShellId('bash_1'))
    expect(second.ok && second.snapshot.shellId).toBe(toShellId('bash_2'))
  })

  it('runs the command in the workspace root', async () => {
    const { registry, root } = openRegistry()

    const started = registry.start({ command: 'pwd' })
    if (!started.ok) throw new Error(started.reason)
    await settle(registry, started.snapshot.shellId)

    const read = registry.read({ shellId: started.snapshot.shellId })
    expect(read.ok && read.delta.text.trim().endsWith(basename(root))).toBe(true)
  })
})

describe('reading a background shell back', () => {
  it('collects what the command printed and reports its exit code', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ command: 'echo hello' })
    if (!started.ok) throw new Error(started.reason)

    await settle(registry, started.snapshot.shellId)
    const read = registry.read({ shellId: started.snapshot.shellId })

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.delta.text).toBe('hello\n')
    expect(read.snapshot.status).toBe(EShellStatus.Exited)
    expect(read.snapshot.exitCode).toBe(0)
  })

  it('interleaves stderr with stdout, since one shell writes one stream of output', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ command: 'echo out; echo err 1>&2' })
    if (!started.ok) throw new Error(started.reason)

    await settle(registry, started.snapshot.shellId)
    const read = registry.read({ shellId: started.snapshot.shellId })

    expect(read.ok && read.delta.text.split('\n').filter(Boolean).sort()).toEqual(['err', 'out'])
  })

  it('advances a cursor, so a second read does not repeat the first', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ command: 'echo once' })
    if (!started.ok) throw new Error(started.reason)
    await settle(registry, started.snapshot.shellId)

    const first = registry.read({ shellId: started.snapshot.shellId })
    const second = registry.read({ shellId: started.snapshot.shellId })

    expect(first.ok && first.delta.text).toBe('once\n')
    expect(second.ok && second.delta.text).toBe('')
    expect(second.ok && second.delta.remainingCharacters).toBe(0)
  })

  it('keeps a failing exit code rather than raising it', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ command: 'echo nope; exit 3' })
    if (!started.ok) throw new Error(started.reason)

    await settle(registry, started.snapshot.shellId)
    const read = registry.read({ shellId: started.snapshot.shellId })

    expect(read.ok && read.snapshot.exitCode).toBe(3)
  })

  it('names the shells it knows when asked for one it does not', () => {
    const { registry } = openRegistry()
    registry.start({ command: 'sleep 30' })

    const read = registry.read({ shellId: 'bash_99' })

    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.reason).toContain('bash_99')
    expect(read.reason).toContain('bash_1')
  })

  it('says so when nothing is running at all', () => {
    const { registry } = openRegistry()

    const read = registry.read({ shellId: 'bash_1' })

    expect(read.ok === false && read.reason).toContain('none is running')
  })
})

describe('killing a background shell', () => {
  it('stops it and reports it killed rather than exited', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ command: 'sleep 60' })
    if (!started.ok) throw new Error(started.reason)

    const killed = registry.kill({ shellId: started.snapshot.shellId })
    expect(killed.ok).toBe(true)

    await settle(registry, started.snapshot.shellId)
    const read = registry.read({ shellId: started.snapshot.shellId })
    expect(read.ok && read.snapshot.status).toBe(EShellStatus.Killed)
  })

  it('reaches a process the shell forked, not only the shell', async () => {
    const { registry, root } = openRegistry()
    const witness = join(root, 'survivor.txt')
    const started = registry.start({ command: `(sleep 2; echo alive > ${witness}) & wait` })
    if (!started.ok) throw new Error(started.reason)

    await Bun.sleep(150)
    registry.kill({ shellId: started.snapshot.shellId })
    await settle(registry, started.snapshot.shellId)
    await Bun.sleep(2200)

    expect(await Bun.file(witness).exists()).toBe(false)
  })

  it('refuses a shell it does not know', () => {
    const { registry } = openRegistry()

    expect(registry.kill({ shellId: 'bash_7' }).ok).toBe(false)
  })

  it('is harmless on a shell that already finished', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ command: 'echo done' })
    if (!started.ok) throw new Error(started.reason)
    await settle(registry, started.snapshot.shellId)

    const killed = registry.kill({ shellId: started.snapshot.shellId })

    expect(killed.ok && killed.snapshot.status).toBe(EShellStatus.Exited)
  })
})

describe('telling the model a background shell finished', () => {
  it('queues one draft naming the shell, how it ended, and what it printed', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ command: 'echo hi', description: 'Say hi' })
    if (!started.ok) throw new Error(started.reason)

    await settle(registry, started.snapshot.shellId)
    const drained = registry.drainNotifications()

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
    const { registry } = openRegistry()
    const started = registry.start({ command: 'echo already-delivered' })
    if (!started.ok) throw new Error(started.reason)
    await settle(registry, started.snapshot.shellId)

    const delivered = endedDraft(registry.drainNotifications()[0])
    const read = registry.read({ shellId: started.snapshot.shellId })

    expect(delivered.output).toBe('already-delivered\n')
    expect(read.ok && read.delta.text).toBe('')
  })

  it('drains once, so the same ending is never announced twice', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ command: 'echo hi' })
    if (!started.ok) throw new Error(started.reason)
    await settle(registry, started.snapshot.shellId)

    registry.drainNotifications()

    expect(registry.drainNotifications()).toEqual([])
  })

  it('queues nothing while the command is still running', async () => {
    const { registry } = openRegistry()
    registry.start({ command: 'sleep 30' })

    await Bun.sleep(100)

    expect(registry.drainNotifications()).toEqual([])
  })
})

describe('waking whoever is listening', () => {
  it('tells a listener the moment a shell ends, so an idle session need not be polled', async () => {
    const { registry } = openRegistry()
    let woken = 0
    registry.onNotice(() => {
      woken += 1
    })

    const started = registry.start({ command: 'echo hi' })
    if (!started.ok) throw new Error(started.reason)
    await settle(registry, started.snapshot.shellId)

    expect(woken).toBeGreaterThanOrEqual(1)
    expect(registry.pendingNotices()).toHaveLength(1)
  })

  it('shows an undrained notice without consuming it, so it can be displayed while a turn runs', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ command: 'echo hi' })
    if (!started.ok) throw new Error(started.reason)
    await settle(registry, started.snapshot.shellId)

    expect(registry.pendingNotices()).toHaveLength(1)
    expect(registry.pendingNotices()).toHaveLength(1)
    expect(registry.drainNotifications()).toHaveLength(1)
    expect(registry.pendingNotices()).toEqual([])
  })

  it('tells the listener again when a notice leaves the queue, so a display can clear itself', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ command: 'echo hi' })
    if (!started.ok) throw new Error(started.reason)
    await settle(registry, started.snapshot.shellId)

    let woken = 0
    registry.onNotice(() => {
      woken += 1
    })
    registry.drainNotifications()

    expect(woken).toBe(1)
  })

  it('stops telling a listener that has unsubscribed', async () => {
    const { registry } = openRegistry()
    let woken = 0
    const stop = registry.onNotice(() => {
      woken += 1
    })
    stop()

    const started = registry.start({ command: 'echo hi' })
    if (!started.ok) throw new Error(started.reason)
    await settle(registry, started.snapshot.shellId)

    expect(woken).toBe(0)
  })

  it('forgets what is queued, so an ending does not gate-crash a conversation that did not start it', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ command: 'echo hi' })
    if (!started.ok) throw new Error(started.reason)
    await settle(registry, started.snapshot.shellId)

    registry.forgetNotices()

    expect(registry.pendingNotices()).toEqual([])
    expect(registry.drainNotifications()).toEqual([])
  })
})

describe('noticing a background shell stuck on a prompt', () => {
  const awaitingInputOf = async (registry: ShellRegistryPort, shellId: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const snapshot = registry.list().find((entry) => entry.shellId === shellId)
      if (snapshot?.awaitingInput === true) return true
      await Bun.sleep(25)
    }
    return false
  }

  it('reports a running shell whose last line looks like a question as awaiting input', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ command: `printf 'Overwrite? (y/n) '; sleep 30` })
    if (!started.ok) throw new Error(started.reason)

    expect(await awaitingInputOf(registry, started.snapshot.shellId)).toBe(true)
  })

  it('says nothing of the sort about a shell printing ordinary progress', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ command: `echo 'compiled 12 modules'; sleep 30` })
    if (!started.ok) throw new Error(started.reason)
    await Bun.sleep(300)

    const snapshot = registry.list().find((entry) => entry.shellId === started.snapshot.shellId)

    expect(snapshot?.awaitingInput).toBe(false)
  })

  it('never queues a notification for it, so a slow command is left alone however long it runs', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ command: `printf 'Password: '; sleep 30` })
    if (!started.ok) throw new Error(started.reason)
    await awaitingInputOf(registry, started.snapshot.shellId)

    expect(registry.drainNotifications()).toEqual([])
  })

  it('stops claiming it once the shell has ended', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ command: `printf 'Continue? (y/n) '` })
    if (!started.ok) throw new Error(started.reason)
    await settle(registry, started.snapshot.shellId)

    const snapshot = registry.list().find((entry) => entry.shellId === started.snapshot.shellId)

    expect(snapshot?.awaitingInput).toBe(false)
  })
})

describe('announcing every ending, whoever caused it', () => {
  it('announces a failure, naming the code', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ command: 'exit 7' })
    if (!started.ok) throw new Error(started.reason)
    await settle(registry, started.snapshot.shellId)

    expect(endedDraft(registry.drainNotifications()[0]).exitCode).toBe(7)
  })

  it('announces a shell the developer killed, so the model stops reasoning about a dead server', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ command: 'sleep 60' })
    if (!started.ok) throw new Error(started.reason)

    registry.kill({ shellId: started.snapshot.shellId })
    await announced(registry)

    const drained = registry.drainNotifications()
    expect(drained).toHaveLength(1)
    expect(endedDraft(drained[0]).status).toBe(ECoreShellStatus.Killed)
  })

  it('announces a shell killed by teardown rather than suppressing it', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ command: 'sleep 60' })
    if (!started.ok) throw new Error(started.reason)

    await registry.closeAll()

    const drained = registry.drainNotifications()
    expect(drained).toHaveLength(1)
    expect(endedDraft(drained[0]).shellId).toBe(started.snapshot.shellId)
  })

  it('still announces each ending exactly once', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ command: 'echo hi' })
    if (!started.ok) throw new Error(started.reason)
    await settle(registry, started.snapshot.shellId)

    registry.drainNotifications()

    expect(registry.drainNotifications()).toEqual([])
  })
})

describe('looking at a shell without consuming it', () => {
  it('peeks at the tail without moving the cursor the model reads through', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ command: 'echo watched' })
    if (!started.ok) throw new Error(started.reason)
    await settle(registry, started.snapshot.shellId)

    const peeked = registry.peek({ shellId: started.snapshot.shellId, characters: 100 })
    const read = registry.read({ shellId: started.snapshot.shellId })

    expect(peeked).toBe('watched\n')
    expect(read.ok && read.delta.text).toBe('watched\n')
  })

  it('peeks at nothing for a shell it does not know', () => {
    const { registry } = openRegistry()

    expect(registry.peek({ shellId: 'bash_3', characters: 100 })).toBeUndefined()
  })
})

describe('closing the session down', () => {
  it('kills what the session left running, so no shell outlives its spawner', async () => {
    const { registry, root } = openRegistry()
    const witness = join(root, 'zombie.txt')
    const started = registry.start({ command: `sleep 2; echo alive > ${witness}` })
    if (!started.ok) throw new Error(started.reason)
    await Bun.sleep(150)

    await registry.closeAll()
    await Bun.sleep(2200)

    expect(await Bun.file(witness).exists()).toBe(false)
  })

  it('forgets the shells, so a stale id is not silently readable after teardown', async () => {
    const { registry } = openRegistry()
    registry.start({ command: 'sleep 30' })

    await registry.closeAll()

    expect(registry.list()).toEqual([])
    expect(registry.read({ shellId: 'bash_1' }).ok).toBe(false)
  })

  it('keeps a pending notification through teardown, so the ending is not lost with the shell', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ command: 'echo hi' })
    if (!started.ok) throw new Error(started.reason)
    await settle(registry, started.snapshot.shellId)

    await registry.closeAll()

    expect(registry.drainNotifications()).toHaveLength(1)
  })
})
