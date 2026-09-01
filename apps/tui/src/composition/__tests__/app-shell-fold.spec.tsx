import { EShellStatus, toShellId, type ShellSnapshot } from '@dltech/atlas-harness'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { App } from '../app'
import { spokenIn } from './app-fixture'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const WIDE = { width: 150, height: 40 }

const LONG_AGO = '2020-01-01T00:00:00.000Z'

const shellOf = (over: {
  shellId: string
  description: string
  status?: EShellStatus
  exitCode?: number
  awaitingInput?: boolean
  endedAt?: string | undefined
}): ShellSnapshot => ({
  shellId: toShellId(over.shellId),
  command: `run ${over.shellId}`,
  description: over.description,
  status: over.status ?? EShellStatus.Exited,
  pid: 4242,
  startedAt: LONG_AGO,
  lastOutputAt: LONG_AGO,
  totalCharacters: 24,
  awaitingInput: over.awaitingInput ?? false,
  ...(over.exitCode === undefined ? {} : { exitCode: over.exitCode }),
  ...('endedAt' in over ? { endedAt: over.endedAt } : { endedAt: LONG_AGO }),
})

const settled = (args: { shellId: string; description: string }): ShellSnapshot =>
  shellOf({ ...args, exitCode: 0 })

const appWith = (shells: readonly ShellSnapshot[]): FakeApp => {
  const app = fakeApp({
    model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }),
  })
  for (const shell of shells) app.shells.place(shell)
  return app
}

type Mounted = Awaited<ReturnType<typeof testRender>>

async function opened(app: FakeApp): Promise<Mounted> {
  const setup = await testRender(<App app={app} opened={await spokenIn(app)} />, WIDE)
  await setup.flush()
  await settle(250)
  await setup.flush()
  return setup
}

describe('a finished background shell leaving the sidebar', () => {
  it('takes the whole heading with it once a clean exit has served its grace', async () => {
    const setup = await opened(
      appWith([settled({ shellId: 'bash_gone', description: 'compiling assets' })]),
    )

    try {
      const frame = setup.captureCharFrame()

      expect(frame).not.toContain('compiling assets')
      expect(frame).not.toContain('SHELLS')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('never reclaims a failure the operator has not opened', async () => {
    const setup = await opened(
      appWith([shellOf({ shellId: 'bash_bad', description: 'seeding fixtures', exitCode: 2 })]),
    )

    try {
      expect(setup.captureCharFrame()).toContain('seeding fixtures')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('never reclaims a shell that is waiting on a human', async () => {
    const setup = await opened(
      appWith([
        shellOf({
          shellId: 'bash_ask',
          description: 'unlocking a keyring',
          status: EShellStatus.Running,
          awaitingInput: true,
          endedAt: undefined,
        }),
      ]),
    )

    try {
      expect(setup.captureCharFrame()).toContain('unlocking a keyring')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('counts what it let go of against the total, beside the rows it kept', async () => {
    const setup = await opened(
      appWith([
        shellOf({ shellId: 'bash_bad', description: 'seeding fixtures', exitCode: 2 }),
        settled({ shellId: 'bash_gone', description: 'compiling assets' }),
      ]),
    )

    try {
      const frame = setup.captureCharFrame()

      expect(frame).toContain('seeding fixtures')
      expect(frame).not.toContain('compiling assets')
      expect(frame).toContain('SHELLS  0/2')
      expect(frame).toContain('1 more in /shells')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('keeps a running shell while its settled siblings retire around it', async () => {
    const setup = await opened(
      appWith([
        shellOf({
          shellId: 'bash_live',
          description: 'watching stylesheets',
          status: EShellStatus.Running,
          endedAt: undefined,
        }),
        settled({ shellId: 'bash_gone', description: 'compiling assets' }),
      ]),
    )

    try {
      const frame = setup.captureCharFrame()

      expect(frame).toContain('watching stylesheets')
      expect(frame).not.toContain('compiling assets')
      expect(frame).toContain('SHELLS  1/2')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
