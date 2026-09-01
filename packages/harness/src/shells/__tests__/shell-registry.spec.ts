import { afterEach, describe, expect, it } from 'bun:test'
import { basename } from 'node:path'

import { EShellStatus } from '../background-shell'
import { toShellId } from '../shell-id'
import { closeRegistries, job, openRegistry, settle, THREAD } from './shell-registry-fixture'

afterEach(closeRegistries)

describe('starting a shell in the background', () => {
  it('returns a shell id at once rather than waiting for the command', () => {
    const { registry } = openRegistry()

    const started = registry.start(job({ command: 'sleep 30' }))

    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.snapshot.shellId).toBe(toShellId('bash_1'))
    expect(started.snapshot.status).toBe(EShellStatus.Running)
  })

  it('numbers each shell so two are told apart', () => {
    const { registry } = openRegistry()

    const first = registry.start(job({ command: 'sleep 30' }))
    const second = registry.start(job({ command: 'sleep 30' }))

    expect(first.ok && first.snapshot.shellId).toBe(toShellId('bash_1'))
    expect(second.ok && second.snapshot.shellId).toBe(toShellId('bash_2'))
  })

  it('runs the command in the workspace root', async () => {
    const { registry, root } = openRegistry()

    const started = registry.start(job({ command: 'pwd' }))
    if (!started.ok) throw new Error(started.reason)
    await settle({ registry, shellId: started.snapshot.shellId })

    const read = registry.read({ shellId: started.snapshot.shellId, threadId: THREAD })
    expect(read.ok && read.delta.text.trim().endsWith(basename(root))).toBe(true)
  })
})

describe('reading a background shell back', () => {
  it('collects what the command printed and reports its exit code', async () => {
    const { registry } = openRegistry()
    const started = registry.start(job({ command: 'echo hello' }))
    if (!started.ok) throw new Error(started.reason)

    await settle({ registry, shellId: started.snapshot.shellId })
    const read = registry.read({ shellId: started.snapshot.shellId, threadId: THREAD })

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.delta.text).toBe('hello\n')
    expect(read.snapshot.status).toBe(EShellStatus.Exited)
    expect(read.snapshot.exitCode).toBe(0)
  })

  it('interleaves stderr with stdout, since one shell writes one stream of output', async () => {
    const { registry } = openRegistry()
    const started = registry.start(job({ command: 'echo out; echo err 1>&2' }))
    if (!started.ok) throw new Error(started.reason)

    await settle({ registry, shellId: started.snapshot.shellId })
    const read = registry.read({ shellId: started.snapshot.shellId, threadId: THREAD })

    expect(read.ok && read.delta.text.split('\n').filter(Boolean).sort()).toEqual(['err', 'out'])
  })

  it('advances a cursor, so a second read does not repeat the first', async () => {
    const { registry } = openRegistry()
    const started = registry.start(job({ command: 'echo once' }))
    if (!started.ok) throw new Error(started.reason)
    await settle({ registry, shellId: started.snapshot.shellId })

    const first = registry.read({ shellId: started.snapshot.shellId, threadId: THREAD })
    const second = registry.read({ shellId: started.snapshot.shellId, threadId: THREAD })

    expect(first.ok && first.delta.text).toBe('once\n')
    expect(second.ok && second.delta.text).toBe('')
    expect(second.ok && second.delta.remainingCharacters).toBe(0)
  })

  it('keeps a failing exit code rather than raising it', async () => {
    const { registry } = openRegistry()
    const started = registry.start(job({ command: 'echo nope; exit 3' }))
    if (!started.ok) throw new Error(started.reason)

    await settle({ registry, shellId: started.snapshot.shellId })
    const read = registry.read({ shellId: started.snapshot.shellId, threadId: THREAD })

    expect(read.ok && read.snapshot.exitCode).toBe(3)
  })

  it('names the shells it knows when asked for one it does not', () => {
    const { registry } = openRegistry()
    registry.start(job({ command: 'sleep 30' }))

    const read = registry.read({ shellId: 'bash_99', threadId: THREAD })

    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.reason).toContain('bash_99')
    expect(read.reason).toContain('bash_1')
  })

  it('says so when nothing is running at all', () => {
    const { registry } = openRegistry()

    const read = registry.read({ shellId: 'bash_1', threadId: THREAD })

    expect(read.ok === false && read.reason).toContain('none is running')
  })
})

describe('looking at a shell without consuming it', () => {
  it('peeks at the tail without moving the cursor the model reads through', async () => {
    const { registry } = openRegistry()
    const started = registry.start(job({ command: 'echo watched' }))
    if (!started.ok) throw new Error(started.reason)
    await settle({ registry, shellId: started.snapshot.shellId })

    const peeked = registry.peek({
      shellId: started.snapshot.shellId,
      characters: 100,
      threadId: THREAD,
    })
    const read = registry.read({ shellId: started.snapshot.shellId, threadId: THREAD })

    expect(peeked).toBe('watched\n')
    expect(read.ok && read.delta.text).toBe('watched\n')
  })

  it('peeks at nothing for a shell it does not know', () => {
    const { registry } = openRegistry()

    expect(registry.peek({ shellId: 'bash_3', characters: 100, threadId: THREAD })).toBeUndefined()
  })
})
