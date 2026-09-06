import { testRender } from '@opentui/react/test-utils'
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React, { act } from 'react'

import {
  EDefinitionOrigin,
  EToolEffect,
  EWorktreeExit,
  toCallId,
  toThreadId,
  type ToolCall,
  type ToolOutcome,
} from '@dltech/atlas-core'
import {
  createIsolatedContainer,
  portToken,
  resolveHookChain,
  WorkspaceRoot,
} from '@dltech/atlas-harness'

import { loadPlugins } from '../../load'
import { NativePlugin, type PluginHost } from '../../plugin'
import type { PluginSurface } from '../../surface'
import GithubPlugin, { registerPlugin } from '../index'

import { settle, teardown } from '../../../ui/markdown/__tests__/harness'
import { spansOf } from '../../../ui/sidebar-section'

const RENDER_MS = 40

const WIDE = 200

const made: string[] = []

const scratch = async (): Promise<string> => {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'atlas-follow-')))
  made.push(path)
  return path
}

const git = async (args: readonly string[], cwd: string): Promise<void> => {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' })
  const status = await proc.exited
  if (status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}`)
}

/**
 * The remote is not GitHub on purpose: the checkout still parses, so the branch row renders, but
 * the port refuses the forge before it would reach the network.
 */
const repoWithWorktree = async (): Promise<{ root: string; worktree: string }> => {
  const root = await scratch()
  await git(['init', '-b', 'main'], root)
  await git(['config', 'user.email', 'test@example.com'], root)
  await git(['config', 'user.name', 'Test'], root)
  await git(['remote', 'add', 'origin', 'https://example.com/o/r.git'], root)
  await Bun.write(join(root, 'README.md'), 'hello')
  await git(['add', '.'], root)
  await git(['commit', '-m', 'initial'], root)

  const worktree = join(root, 'wt')
  await git(['worktree', 'add', worktree, '-b', 'dennis/thing'], root)
  return { root, worktree }
}

afterAll(async () => {
  await Promise.all(made.map((path) => rm(path, { recursive: true, force: true })))
})

const THREAD = toThreadId('thread-follow')

const entered = (path: string): ToolOutcome => ({
  ok: true,
  output: { enteredWorktree: { path, branch: 'dennis/thing', base: 'origin/main' } },
  modelText: 'entered',
})

const exited = (path: string): ToolOutcome => ({
  ok: true,
  output: { exitedWorktree: { path, action: EWorktreeExit.Keep } },
  modelText: 'exited',
})

const callNamed = (name: string): ToolCall => ({
  callId: toCallId('call-1'),
  name,
  input: {},
  effect: EToolEffect.Destructive,
  threadId: THREAD,
})

const NEVER_ABORTED = new AbortController().signal

type Probe = { surface: PluginSurface | null }

function Host(props: { use: () => PluginSurface; probe: Probe }): React.ReactNode {
  props.probe.surface = props.use()
  return <text>{props.probe.surface.sidebarSection === null ? 'no section' : 'section'}</text>
}

const branchRowOf = (probe: Probe): string | null => {
  const row = probe.surface?.sidebarSection?.rows.find((entry) => entry.id === 'branch')
  if (row === undefined) return null

  return spansOf({ row, cells: WIDE }).map((span) => span.text).join('')
}

/**
 * The whole runtime path the app takes, with nothing faked but the model: the plugin registers
 * through the same loader and the same chain resolver compose uses, the surface renders for real,
 * and the git checkouts are real directories on disk.
 */
const composed = async (): Promise<{
  probe: Probe
  worktree: string
  chain: ReturnType<typeof resolveHookChain>
  flush: () => Promise<void>
  done: () => Promise<void>
}> => {
  const { root, worktree } = await repoWithWorktree()

  const container = createIsolatedContainer()
  container.register(WorkspaceRoot, { useValue: root })
  registerPlugin({ container })

  const plugin = container.resolve(portToken(NativePlugin))
  if (!(plugin instanceof GithubPlugin)) throw new Error('the container answered something else')

  const loaded = await loadPlugins({
    plugins: [{ origin: EDefinitionOrigin.BuiltIn, plugin }],
    host: (): PluginHost => {
      throw new Error('a native never receives a host')
    },
    container,
  })

  const chain = resolveHookChain({ container })
  const surface = loaded.surfaces[0]
  if (surface === undefined) throw new Error('the plugin contributed no surface')

  const probe: Probe = { surface: null }
  const setup = await testRender(<Host use={surface.use} probe={probe} />, { width: 60, height: 4 })
  const flush = async (): Promise<void> => {
    await act(async () => {
      await settle(RENDER_MS)
    })
    await setup.flush()
  }
  await flush()

  return {
    probe,
    worktree,
    chain,
    flush,
    done: async () => {
      await teardown(setup)
    },
  }
}

describe('the github section following the session, through the real wiring', () => {
  it('shows the launch branch first, then the worktree branch once a turn opens there', async () => {
    const { probe, worktree, chain, flush, done } = await composed()

    try {
      expect(branchRowOf(probe)).toBe('main')

      await act(async () => {
        await chain.beforeTurn({ threadId: THREAD, projectDirectory: worktree })
      })
      await flush()

      expect(branchRowOf(probe)).toBe('dennis/thing')
    } finally {
      await done()
    }
  })

  it('follows a resumed thread into its worktree before any turn runs in the process', async () => {
    const { probe, worktree, chain, flush, done } = await composed()

    try {
      expect(branchRowOf(probe)).toBe('main')

      await act(async () => {
        await chain.onThreadOpen({ threadId: THREAD, projectDirectory: worktree })
      })
      await flush()

      expect(branchRowOf(probe)).toBe('dennis/thing')
    } finally {
      await done()
    }
  })

  it('moves mid-turn when enter_worktree lands, and back when exit_worktree does', async () => {
    const { probe, worktree, chain, flush, done } = await composed()

    try {
      expect(branchRowOf(probe)).toBe('main')

      await act(async () => {
        for (const hook of chain.afterTool) {
          await hook.run({ call: callNamed('enter_worktree'), result: entered(worktree), projectDirectory: '/repo', signal: NEVER_ABORTED })
        }
      })
      await flush()
      expect(branchRowOf(probe)).toBe('dennis/thing')

      await act(async () => {
        for (const hook of chain.afterTool) {
          await hook.run({ call: callNamed('exit_worktree'), result: exited(worktree), projectDirectory: '/repo', signal: NEVER_ABORTED })
        }
      })
      await flush()
      expect(branchRowOf(probe)).toBe('main')
    } finally {
      await done()
    }
  })
})
