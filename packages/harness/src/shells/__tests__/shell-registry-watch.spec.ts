import { afterEach, describe, expect, it } from 'bun:test'

import { EKilledBy, EShellStatus } from '@dltech/atlas-core'

import type { ShellRegistryPort } from '../shell-registry'
import { MATCHED_LINES_CAP } from '../shell-watch'
import {
  announced,
  closeRegistries,
  endedDraft,
  matchedDraft,
  openRegistry,
  settle,
  THREAD,
} from './shell-registry-fixture'

afterEach(closeRegistries)

const watching = ({
  registry,
  command,
  watch,
}: {
  registry: ShellRegistryPort
  command: string
  watch: string
}) => {
  const started = registry.start({
    threadId: THREAD,
    command,
    description: 'Watch a long job',
    watch,
  })
  if (!started.ok) throw new Error(started.reason)
  return started.snapshot
}

const readable = async ({
  registry,
  shellId,
}: {
  registry: ShellRegistryPort
  shellId: string
}): Promise<string> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const read = registry.read({ shellId, threadId: THREAD })
    if (read.ok && read.delta.text.length > 0) return read.delta.text
    await Bun.sleep(25)
  }
  throw new Error(`background shell ${shellId} printed nothing`)
}

describe('telling the model what a running shell just printed', () => {
  it('delivers the matching lines while the shell is still running', async () => {
    const { registry } = openRegistry()
    const snapshot = watching({
      registry,
      command: 'echo building; echo "ERROR: the build fell over"; sleep 30',
      watch: 'ERROR|FAILED',
    })

    await announced({ registry })
    const drained = registry.drainNotifications({ threadId: THREAD })

    expect(drained).toHaveLength(1)
    expect(matchedDraft(drained[0])).toMatchObject({
      type: 'background-shell-matched',
      shellId: snapshot.shellId,
      command: 'echo building; echo "ERROR: the build fell over"; sleep 30',
      pattern: 'ERROR|FAILED',
      lines: 'ERROR: the build fell over',
      matchCount: 1,
    })
    expect(registry.list({ threadId: THREAD })[0]?.status).toBe(EShellStatus.Running)
  })

  it('batches a burst of matching lines into one notice rather than one each', async () => {
    const { registry } = openRegistry()
    watching({
      registry,
      command: 'for i in 1 2 3 4 5; do echo "hit $i"; done; sleep 30',
      watch: 'hit',
    })

    await announced({ registry })
    const drained = registry.drainNotifications({ threadId: THREAD })

    expect(drained).toHaveLength(1)
    expect(matchedDraft(drained[0])).toMatchObject({
      matchCount: 5,
      lines: ['hit 1', 'hit 2', 'hit 3', 'hit 4', 'hit 5'].join('\n'),
    })
  })

  it('says nothing when no line matches, however much the shell prints', async () => {
    const { registry } = openRegistry()
    const snapshot = watching({
      registry,
      command: 'echo quiet progress; sleep 30',
      watch: 'ERROR',
    })
    await readable({ registry, shellId: snapshot.shellId })
    await Bun.sleep(400)

    expect(registry.pendingNotices({ threadId: THREAD })).toEqual([])
  })

  it('leaves a shell with no watch entirely alone', async () => {
    const { registry } = openRegistry()
    const started = registry.start({
      threadId: THREAD,
      command: 'echo ERROR: unwatched; sleep 30',
      description: 'Run unwatched',
    })
    if (!started.ok) throw new Error(started.reason)
    await readable({ registry, shellId: started.snapshot.shellId })
    await Bun.sleep(400)

    expect(registry.pendingNotices({ threadId: THREAD })).toEqual([])
  })
})

describe('keeping the watch off the shell_output cursor', () => {
  it('leaves every matched line where a read can still find it', async () => {
    const { registry } = openRegistry()
    const snapshot = watching({
      registry,
      command: 'echo quiet; echo "ERROR: boom"; sleep 30',
      watch: 'ERROR',
    })

    await announced({ registry })
    const drained = registry.drainNotifications({ threadId: THREAD })
    expect(matchedDraft(drained[0]).lines).toBe('ERROR: boom')

    const read = registry.read({ shellId: snapshot.shellId, threadId: THREAD })

    expect(read.ok && read.delta.text).toBe('quiet\nERROR: boom\n')
  })

  it('still delivers the match after a read has consumed the output it came from', async () => {
    const { registry } = openRegistry()
    const snapshot = watching({
      registry,
      command: 'echo "ERROR: boom"; sleep 30',
      watch: 'ERROR',
    })

    expect(await readable({ registry, shellId: snapshot.shellId })).toBe('ERROR: boom\n')
    await announced({ registry })

    expect(matchedDraft(registry.drainNotifications({ threadId: THREAD })[0])).toMatchObject({
      lines: 'ERROR: boom',
      matchCount: 1,
    })
  })
})

describe('disarming a watch that has said enough', () => {
  it('stops at the cap, says so, and leaves the shell running', async () => {
    const { registry } = openRegistry()
    const snapshot = watching({
      registry,
      command: `for i in $(seq 1 ${MATCHED_LINES_CAP + 50}); do echo "hit $i"; done; sleep 30`,
      watch: 'hit',
    })

    await announced({ registry })
    const drained = registry.drainNotifications({ threadId: THREAD })
    const matched = matchedDraft(drained[0])

    expect(matched.matchCount).toBe(MATCHED_LINES_CAP)
    expect(matched.watchDisarmed).toBe(true)
    expect(matched.lines.split('\n')).toHaveLength(MATCHED_LINES_CAP)
    expect(registry.list({ threadId: THREAD })[0]?.status).toBe(EShellStatus.Running)

    registry.kill({ shellId: snapshot.shellId, by: EKilledBy.Model, threadId: THREAD })
    await announced({ registry })

    expect(endedDraft(registry.drainNotifications({ threadId: THREAD })[0]).shellId).toBe(
      snapshot.shellId,
    )
  }, 20_000)
})

describe('refusing a pattern that is not one', () => {
  it('names the syntax error and starts nothing', () => {
    const { registry } = openRegistry()

    const started = registry.start({
      threadId: THREAD,
      command: 'echo hi',
      description: 'Watch nonsense',
      watch: '(unclosed',
    })

    expect(started.ok).toBe(false)
    expect(!started.ok && started.reason).toContain('not a regular expression')
    expect(registry.list({ threadId: THREAD })).toEqual([])
  })
})

describe('giving a background shell a ceiling', () => {
  it('kills a shell that outlives its timeout and still announces the ending', async () => {
    const { registry } = openRegistry()
    const started = registry.start({
      threadId: THREAD,
      command: 'sleep 30',
      description: 'Wait too long',
      timeoutMs: 300,
    })
    if (!started.ok) throw new Error(started.reason)

    await settle({ registry, shellId: started.snapshot.shellId })
    await announced({ registry })

    expect(endedDraft(registry.drainNotifications({ threadId: THREAD })[0])).toMatchObject({
      shellId: started.snapshot.shellId,
      status: EShellStatus.Killed,
      killedBy: EKilledBy.Timeout,
    })
  }, 15_000)

  it('lets a shell that finishes in time end on its own terms', async () => {
    const { registry } = openRegistry()
    const started = registry.start({
      threadId: THREAD,
      command: 'echo quick',
      description: 'Finish in time',
      timeoutMs: 10_000,
    })
    if (!started.ok) throw new Error(started.reason)

    await settle({ registry, shellId: started.snapshot.shellId })

    expect(endedDraft(registry.drainNotifications({ threadId: THREAD })[0])).toMatchObject({
      status: EShellStatus.Exited,
      exitCode: 0,
    })
  })
})
