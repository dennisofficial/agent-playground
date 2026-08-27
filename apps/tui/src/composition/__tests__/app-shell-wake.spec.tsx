import { EShellStatus, toShellId, type ShellSnapshot } from '@dltech/atlas-harness'
import { describe, expect, it } from 'bun:test'

import { grammarsReady } from '../../ui/markdown/__tests__/harness'
import { open, until } from './app-fixture'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const WAIT_MS = 4_000

const ended = (over: Partial<ShellSnapshot> = {}): ShellSnapshot =>
  ({
    shellId: toShellId('bash_1'),
    command: 'bun test',
    description: 'Run full TUI suite',
    status: EShellStatus.Exited,
    exitCode: 0,
    pid: 4_242,
    startedAt: '2026-08-27T12:00:00.000Z',
    lastOutputAt: '2026-08-27T12:00:01.000Z',
    totalCharacters: 18,
    awaitingInput: false,
    ...over,
  }) as ShellSnapshot

const appNow = (): FakeApp =>
  fakeApp({ model: scriptedModelPort({ script: { thinking: 'reading it', reply: 'all green' } }) })

describe('a background shell that ends while nothing is running', () => {
  it('starts a turn on its own rather than waiting for the next message', async () => {
    const mounted = await open({ app: appNow() })

    try {
      expect(mounted.app.turnsDriven).toBe(0)

      mounted.app.shells.announce(ended())

      const woke = await until({
        holds: async () => mounted.app.turnsDriven > 0,
        within: WAIT_MS,
      })

      expect(woke).toBe(true)
    } finally {
      await mounted.done()
    }
  })

  it('reaches the transcript as an event rather than as something the operator said', async () => {
    const mounted = await open({ app: appNow() })

    try {
      mounted.app.shells.announce(ended())
      await until({
        holds: async () => (await mounted.frame()).includes('Background shell'),
        within: WAIT_MS,
      })

      const frame = await mounted.frame()

      expect(frame).toContain('Background shell "Run full TUI suite" completed (exit code 0)')
      expect(frame).not.toContain('shell_output')
      expect(frame).not.toContain('↑ to edit')
    } finally {
      await mounted.done()
    }
  })

  it('wakes for a shell somebody killed just as readily as one that finished', async () => {
    const mounted = await open({ app: appNow() })

    try {
      mounted.app.shells.announce(ended({ status: EShellStatus.Killed, exitCode: undefined }))

      const woke = await until({
        holds: async () => mounted.app.turnsDriven > 0,
        within: WAIT_MS,
      })

      expect(woke).toBe(true)
      expect(await mounted.frame()).toContain('was killed')
    } finally {
      await mounted.done()
    }
  })

  it('drives one turn for one ending, however many times it re-renders', async () => {
    const mounted = await open({ app: appNow() })

    try {
      mounted.app.shells.announce(ended())
      await until({ holds: async () => mounted.app.turnsDriven > 0, within: WAIT_MS })
      await mounted.frame()
      await mounted.frame()

      expect(mounted.app.turnsDriven).toBe(1)
    } finally {
      await mounted.done()
    }
  })
})
