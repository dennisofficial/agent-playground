import { describe, expect, it } from 'bun:test'

import { createDeltaChannel, ESandboxState } from '@dltech/atlas-harness'

import { createConversationStore } from '../conversation-store'
import { deriveTranscript } from '../derive-transcript'
import type { SidebarContainer } from '../sidebar-model'
import { EEntryKind } from '../transcript-model'
import { fixtureThreadId } from './fixture'

const STARTING: SidebarContainer = {
  state: ESandboxState.Starting,
  image: 'node:22-slim',
  ports: [],
}

const noticesOf = (model: ReturnType<typeof deriveTranscript>) =>
  model.entries.filter((entry) => entry.kind === EEntryKind.SandboxNotice)

describe('the transient sandbox line in the transcript', () => {
  it('narrates a starting container on an otherwise empty transcript', () => {
    const model = deriveTranscript({ events: [], signals: [], sandbox: STARTING })

    expect(model.isEmpty).toBe(false)
    const notice = noticesOf(model).at(-1)
    expect(notice?.text).toContain('starting the container')
    expect(notice?.text).toContain('node:22-slim')
  })

  it("carries the daemon's reason while the sandbox is failed", () => {
    const failed: SidebarContainer = {
      state: ESandboxState.Failed,
      image: 'node:22-slim',
      ports: [],
      reason: 'No such image: atlas-dev-no-such-image:latest',
    }

    const model = deriveTranscript({ events: [], signals: [], sandbox: failed })

    const notice = noticesOf(model).at(-1)
    expect(notice?.text).toContain('the container failed to start')
    expect(notice?.text).toContain('No such image')
  })

  it('says nothing while the sandbox is running or stopped', () => {
    const quiet: readonly SidebarContainer[] = [
      { state: ESandboxState.Running, image: 'node:22-slim', ports: [] },
      { state: ESandboxState.Stopped, image: 'node:22-slim', ports: [] },
    ]

    for (const sandbox of quiet) {
      const model = deriveTranscript({ events: [], signals: [], sandbox })
      expect(noticesOf(model)).toEqual([])
      expect(model.isEmpty).toBe(true)
    }
  })

  it('follows the status as it moves and clears when the state leaves', () => {
    const channel = createDeltaChannel()
    let held: SidebarContainer = STARTING
    const listeners = new Set<() => void>()
    const store = createConversationStore({
      channel,
      threadId: fixtureThreadId,
      sandbox: {
        current: () => held,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => void listeners.delete(listener)
        },
      },
    })

    expect(noticesOf(store.getSnapshot())).toHaveLength(1)

    held = { state: ESandboxState.Running, image: 'node:22-slim', ports: [] }
    for (const listener of [...listeners]) listener()

    expect(noticesOf(store.getSnapshot())).toEqual([])
    expect(store.getSnapshot().isEmpty).toBe(true)
    store.dispose()
  })
})
