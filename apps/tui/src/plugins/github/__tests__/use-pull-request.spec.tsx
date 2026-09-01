import { testRender } from '@opentui/react/test-utils'
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React, { act } from 'react'

import type { SidebarSection } from '../../surface'
import { settle, teardown } from '../../../ui/markdown/__tests__/harness'
import { createPullRequestService, type PullRequestService } from '../pull-request-service'
import {
  EChecksState,
  EPullRequestLookup,
  EPullRequestState,
  PullRequestPort,
  type PullRequestReading,
} from '../pure'
import { usePullRequest, type PullRequestControl } from '../use-pull-request'

import { spansOf } from '../../../ui/sidebar-section'

const WIDE = 200

const made: string[] = []

const git = async (args: readonly string[], cwd: string): Promise<void> => {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' })
  const status = await proc.exited
  if (status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}`)
}

const repoOnBranch = async (branch: string): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'atlas-pr-hook-')))
  made.push(root)
  await git(['init', '-b', branch], root)
  await git(['config', 'user.email', 'test@example.com'], root)
  await git(['config', 'user.name', 'Test'], root)
  await Bun.write(join(root, 'README.md'), 'hello')
  await git(['add', '.'], root)
  await git(['commit', '-m', 'initial'], root)
  await git(['remote', 'add', 'origin', 'git@github.com:dennisofficial/atlas.git'], root)
  return root
}

afterAll(async () => {
  await Promise.all(made.map((path) => rm(path, { recursive: true, force: true })))
})

const FOUND: PullRequestReading = {
  lookup: EPullRequestLookup.Found,
  pullRequest: {
    number: 123,
    title: 'a change',
    url: 'https://github.com/dennisofficial/atlas/pull/123',
    state: EPullRequestState.Open,
    checks: EChecksState.Running,
    tally: { running: 1, passed: 4, failed: 0 },
  },
}

const ABSENT: PullRequestReading = { lookup: EPullRequestLookup.Absent }

const answering = (reading: PullRequestReading): PullRequestPort =>
  new (class extends PullRequestPort {
    readonly pushes = true
    async read(): Promise<PullRequestReading> {
      return reading
    }
  })()

const NEVER = (): void => undefined

type Probe = { control: PullRequestControl | null }

function Watcher(props: {
  probe: Probe
  service: PullRequestService
  projectDirectory: string
}): React.ReactNode {
  const control = usePullRequest({
    service: props.service,
    projectDirectory: props.projectDirectory,
    working: false,
    onOpen: NEVER,
  })
  props.probe.control = control

  return <text>{control.badge === null ? 'no pull request' : control.badge.label}</text>
}

const RENDER_MS = 60

const textOf = (section: SidebarSection | null, id: string): string | null => {
  const row = section?.rows.find((entry) => entry.id === id)
  return row === undefined ? null : spansOf({ row: row, cells: WIDE }).map((span) => span.text).join('')
}

async function mounted(args: { reading: PullRequestReading; branch?: string }): Promise<{
  probe: Probe
  section: () => SidebarSection | null
  done: () => Promise<void>
}> {
  const projectDirectory = await repoOnBranch(args.branch ?? 'feature-x')
  const service = createPullRequestService({ pullRequests: answering(args.reading) })
  const probe: Probe = { control: null }

  const setup = await testRender(
    <Watcher probe={probe} service={service} projectDirectory={projectDirectory} />,
    { width: 60, height: 4 },
  )
  await act(async () => {
    await settle(RENDER_MS)
  })
  await setup.flush()

  return {
    probe,
    section: () => {
      const control = probe.control
      if (control === null) throw new Error('the probe never mounted')
      return control.section
    },
    done: async () => {
      await teardown(setup)
      service.dispose()
    },
  }
}

describe('usePullRequest', () => {
  it('hands the footer a badge and the sidebar its two rows when a pull request is found', async () => {
    const { probe, section, done } = await mounted({ reading: FOUND })

    try {
      expect(probe.control?.badge?.label).toBe('PR #123')
      expect(probe.control?.badge?.checks).toBe(EChecksState.Running)

      const rows = section()
      expect(textOf(rows, 'branch')).toBe('feature-x')
      expect(textOf(rows, 'pull-request')).toContain(`#123 ${EPullRequestState.Open}`)
      expect(textOf(rows, 'pull-request')).toContain('1 running')
      expect(textOf(rows, 'pull-request')).toContain('4 ✓')
    } finally {
      await done()
    }
  })

  it('drops the badge and the pr row when there is definitively no pull request', async () => {
    const { probe, section, done } = await mounted({ reading: ABSENT, branch: 'main' })

    try {
      expect(probe.control?.badge).toBeNull()

      const rows = section()
      expect(textOf(rows, 'branch')).toBe('main')
      expect(textOf(rows, 'pull-request')).toBeNull()
    } finally {
      await done()
    }
  })
})
