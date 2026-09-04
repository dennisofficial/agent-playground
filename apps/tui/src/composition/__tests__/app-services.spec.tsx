import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseColor } from '@opentui/core'
import { EKilledBy, EServiceStatus } from '@dltech/atlas-core'
import type { ServiceSnapshot } from '@dltech/atlas-harness'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { SERVICE_BLUE } from '../../ui/theme'
import { App } from '../app'
import { spokenIn } from './app-fixture'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const WIDE = { width: 150, height: 40 }

const READ_MS = 60

const PILL = '1 service'

const SERVICES_OVERLAY = 'SERVICE LOG'

const logFile = (text: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'atlas-svc-log-')), 'svc_1.log')
  writeFileSync(path, text)
  return path
}

const running = (over: { serviceId: string; command: string; logPath: string }): ServiceSnapshot => ({
  serviceId: over.serviceId,
  command: over.command,
  description: over.command,
  status: EServiceStatus.Running,
  pid: 4242,
  logPath: over.logPath,
  startedAt: '2026-08-27T12:00:00.000Z',
})

const appWith = (services: readonly ServiceSnapshot[]): FakeApp => {
  const app = fakeApp({
    model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }),
  })
  for (const service of services) app.services.place(service)
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

type Colour = { equals: (other: unknown) => boolean }

type Spans = { lines: ({ spans: { text: string; bg: Colour }[] } | undefined)[] }

const pillIsBlue = (setup: Mounted): boolean => {
  const rows = setup.captureCharFrame().split('\n')
  const row = rows.findIndex((line) => line.includes(PILL))
  if (row < 0) return false

  const cell = (rows[row] ?? '').indexOf(PILL)
  let column = 0
  for (const span of (setup.captureSpans() as unknown as Spans).lines[row]?.spans ?? []) {
    const width = [...span.text].length
    if (cell < column + width) return span.bg.equals(parseColor(SERVICE_BLUE))
    column += width
  }
  return false
}

async function openViaSidebar(setup: Mounted): Promise<void> {
  const rows = setup.captureCharFrame().split('\n')
  const row = rows.findIndex((line) => line.includes('bun run dev'))
  const column = (rows[row] ?? '').indexOf('bun run dev')

  expect(row).toBeGreaterThanOrEqual(0)

  await setup.mockMouse.click(column, row)
  await settle(READ_MS)
  await setup.flush()
}

describe('a running service in the footer and the sidebar', () => {
  it('carries a blue pill in the footer while one runs', async () => {
    const setup = await opened(
      appWith([
        running({ serviceId: 'svc_1', command: 'bun run dev', logPath: logFile('listening\n') }),
      ]),
    )

    try {
      const frame = setup.captureCharFrame()

      expect(frame).toContain(PILL)
      expect(frame).toContain('SERVICES')
      expect(pillIsBlue(setup)).toBe(true)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('opens the live log for the service row clicked in the sidebar', async () => {
    const setup = await opened(
      appWith([
        running({
          serviceId: 'svc_1',
          command: 'bun run dev',
          logPath: logFile('listening on :3000\n'),
        }),
      ]),
    )

    try {
      const rows = setup.captureCharFrame().split('\n')
      const row = rows.findIndex((line) => line.includes('bun run dev'))
      const column = (rows[row] ?? '').indexOf('bun run dev')

      expect(row).toBeGreaterThanOrEqual(0)

      await setup.mockMouse.click(column, row)
      await settle(READ_MS)
      await setup.flush()

      const frame = setup.captureCharFrame()

      expect(frame).toContain(SERVICES_OVERLAY)
      expect(frame).toContain('listening on :3000')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('opens the log when the footer pill fires', async () => {
    const setup = await opened(
      appWith([
        running({ serviceId: 'svc_1', command: 'bun run dev', logPath: logFile('ready\n') }),
      ]),
    )

    try {
      setup.mockInput.pressArrow('down')
      await setup.flush()
      await settle(READ_MS)
      await setup.flush()

      setup.mockInput.pressEnter()
      await setup.flush()
      await settle(250)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain(SERVICES_OVERLAY)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('closes the log again on escape', async () => {
    const setup = await opened(
      appWith([
        running({ serviceId: 'svc_1', command: 'bun run dev', logPath: logFile('ready\n') }),
      ]),
    )

    try {
      await openViaSidebar(setup)
      expect(setup.captureCharFrame()).toContain(SERVICES_OVERLAY)

      setup.mockInput.pressEscape()
      await settle(READ_MS)
      await setup.flush()

      expect(setup.captureCharFrame()).not.toContain(SERVICES_OVERLAY)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('stops the running service on k', async () => {
    const app = appWith([
      running({ serviceId: 'svc_1', command: 'bun run dev', logPath: logFile('ready\n') }),
    ])
    const setup = await opened(app)

    try {
      await openViaSidebar(setup)
      expect(setup.captureCharFrame()).toContain(SERVICES_OVERLAY)

      setup.mockInput.pressKey('k')
      await settle(READ_MS)
      await setup.flush()

      expect(app.services.stopped).toContainEqual({ serviceId: 'svc_1', by: EKilledBy.User })
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
