import { describe, expect, it } from 'bun:test'

import { EventLogPort, EShellStatus, toThreadId, type EventDraft } from '@dltech/atlas-core'
import { RandomIds } from '@dltech/atlas-harness'

import { teardownSession, type TeardownSource } from '../session-teardown'

const THREAD = toThreadId('thread-under-test')

const recordingSource = (args: {
  calls: string[]
  name: string
  drafts?: readonly EventDraft[]
  throws?: boolean
}): TeardownSource => ({
  closeAll: async () => {
    args.calls.push(`${args.name}:closeAll`)
    if (args.throws === true) throw new Error(`${args.name} would not close`)
  },
  threadsAwaitingNotice: () => (args.drafts === undefined ? [] : [THREAD]),
  drainNotifications: () => {
    args.calls.push(`${args.name}:drain`)
    return args.drafts ?? []
  },
})

const recordingLog = (calls: string[]): EventLogPort =>
  new (class extends EventLogPort {
    async append(): Promise<never[]> {
      calls.push('log:append')
      return []
    }

    async read(): Promise<never[]> {
      return []
    }

    async head(): Promise<number> {
      return 0
    }

    async readOwn(): Promise<never[]> {
      return []
    }
  })()

describe('teardownSession', () => {
  const DRAFT: EventDraft = {
    type: 'background-shell-ended',
    shellId: 'bash_1',
    command: 'bun run dev',
    description: 'dev server',
    status: EShellStatus.Killed,
    exitCode: undefined,
    output: '...',
    droppedCharacters: 0,
    remainingCharacters: 0,
  }

  it('stops the sandbox only after the shells are closed and their endings appended', async () => {
    const calls: string[] = []
    const source = recordingSource({ calls, name: 'shells', drafts: [DRAFT] })

    await teardownSession({
      sources: [source],
      log: recordingLog(calls),
      ids: new RandomIds(),
      stopSandbox: async () => {
        calls.push('sandbox:stop')
      },
    })

    expect(calls).toEqual(['shells:closeAll', 'shells:drain', 'log:append', 'sandbox:stop'])
  })

  it('stops the sandbox even when a registry refuses to close', async () => {
    const calls: string[] = []
    const broken = recordingSource({ calls, name: 'broken', throws: true })
    let stopped = false

    await expect(
      teardownSession({
        sources: [broken],
        log: recordingLog(calls),
        ids: new RandomIds(),
        stopSandbox: async () => {
          stopped = true
        },
      }),
    ).rejects.toThrow('broken would not close')

    expect(stopped).toBe(true)
  })
})
