import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act, useState } from 'react'

import type { DiffStat } from '../../header-bar'
import { ETerminalFocus } from '../../focus-store'
import { useDiffStat } from '../use-diff-stat'
import type { DiffStatProbe } from '../diff-stat-probe'
import { settle, teardown } from '../../markdown/__tests__/harness'

const RENDER_MS = 40

type Probe = {
  stat: DiffStat | null | undefined
  setDirectory: ((directory: string) => void) | null
  setWorking: ((working: boolean) => void) | null
  setFocused: ((focus: ETerminalFocus) => void) | null
  setMutations: ((mutations: number) => void) | null
}

function Watcher(props: {
  probe: Probe
  askGit: DiffStatProbe
  directory: string
}): React.ReactNode {
  const [directory, setDirectory] = useState(props.directory)
  const [working, setWorking] = useState(false)
  const [focus, setFocused] = useState(ETerminalFocus.Unknown)
  const [mutations, setMutations] = useState(0)

  props.probe.setDirectory = setDirectory
  props.probe.setWorking = setWorking
  props.probe.setFocused = setFocused
  props.probe.setMutations = setMutations
  props.probe.stat = useDiffStat({
    projectDirectory: directory,
    working,
    focus,
    mutations,
    probe: props.askGit,
  })

  return <text>{props.probe.stat === null ? 'clean' : 'dirty'}</text>
}

async function mounted(args: { askGit: DiffStatProbe; directory?: string }): Promise<{
  probe: Probe
  flush: () => Promise<void>
  done: () => Promise<void>
}> {
  const probe: Probe = {
    stat: undefined,
    setDirectory: null,
    setWorking: null,
    setFocused: null,
    setMutations: null,
  }

  const setup = await testRender(
    <Watcher probe={probe} askGit={args.askGit} directory={args.directory ?? '/work/atlas'} />,
    { width: 60, height: 4 },
  )
  const flush = async (): Promise<void> => {
    await act(async () => {
      await settle(RENDER_MS)
    })
    await setup.flush()
  }
  await flush()

  return {
    probe,
    flush,
    done: () => teardown(setup),
  }
}

const countingProbe = (stat: DiffStat): DiffStatProbe & { calls: string[] } => {
  const calls: string[] = []
  return Object.assign(
    async ({ directory }: { directory: string }) => {
      calls.push(directory)
      return stat
    },
    { calls },
  )
}

describe('what makes useDiffStat ask git again', () => {
  it('probes once on mount', async () => {
    const askGit = countingProbe({ added: 3, removed: 1 })
    const { probe, done } = await mounted({ askGit })

    try {
      expect(askGit.calls).toEqual(['/work/atlas'])
      expect(probe.stat).toEqual({ added: 3, removed: 1 })
    } finally {
      await done()
    }
  })

  it('re-probes when the turn ends, and not when it starts', async () => {
    const askGit = countingProbe({ added: 3, removed: 1 })
    const { probe, flush, done } = await mounted({ askGit })

    try {
      act(() => probe.setWorking?.(true))
      await flush()
      expect(askGit.calls).toHaveLength(1)

      act(() => probe.setWorking?.(false))
      await flush()
      expect(askGit.calls).toEqual(['/work/atlas', '/work/atlas'])
    } finally {
      await done()
    }
  })

  it('re-probes on a directory change even while the turn is still running', async () => {
    const askGit = countingProbe({ added: 3, removed: 1 })
    const { probe, flush, done } = await mounted({ askGit })

    try {
      act(() => probe.setWorking?.(true))
      await flush()
      act(() => probe.setDirectory?.('/work/atlas/.claude/worktrees/thing'))
      await flush()

      expect(askGit.calls).toEqual(['/work/atlas', '/work/atlas/.claude/worktrees/thing'])
    } finally {
      await done()
    }
  })

  it('re-probes when the terminal regains focus, but not on first focus or on blur', async () => {
    const askGit = countingProbe({ added: 3, removed: 1 })
    const { probe, flush, done } = await mounted({ askGit })

    try {
      act(() => probe.setFocused?.(ETerminalFocus.Focused))
      await flush()
      expect(askGit.calls).toHaveLength(1)

      act(() => probe.setFocused?.(ETerminalFocus.Blurred))
      await flush()
      expect(askGit.calls).toHaveLength(1)

      act(() => probe.setFocused?.(ETerminalFocus.Focused))
      await flush()
      expect(askGit.calls).toEqual(['/work/atlas', '/work/atlas'])
    } finally {
      await done()
    }
  })

  it('re-probes as the mutation count grows mid-turn', async () => {
    const askGit = countingProbe({ added: 3, removed: 1 })
    const { probe, flush, done } = await mounted({ askGit })

    try {
      act(() => probe.setMutations?.(1))
      await flush()
      expect(askGit.calls).toHaveLength(2)

      act(() => probe.setMutations?.(2))
      await flush()
      expect(askGit.calls).toHaveLength(3)
    } finally {
      await done()
    }
  })

  it('keeps the same stat object while the answer does not change', async () => {
    const askGit = countingProbe({ added: 3, removed: 1 })
    const { probe, flush, done } = await mounted({ askGit })

    try {
      const first = probe.stat
      act(() => probe.setWorking?.(true))
      await flush()
      act(() => probe.setWorking?.(false))
      await flush()

      expect(probe.stat).toBe(first)
    } finally {
      await done()
    }
  })
})

describe('a probe that lands out of order', () => {
  it('never re-pins the bar to the directory the session has left', async () => {
    const held: { release: (() => void) | null } = { release: null }
    const askGit: DiffStatProbe = async ({ directory }) => {
      if (directory === '/work/old') {
        await new Promise<void>((resolve) => {
          held.release = resolve
        })
      }
      return directory === '/work/old' ? { added: 99, removed: 0 } : { added: 1, removed: 0 }
    }

    const { probe, flush, done } = await mounted({ askGit, directory: '/work/old' })

    try {
      expect(probe.stat).toBeNull()

      act(() => probe.setDirectory?.('/work/new'))
      await flush()
      expect(probe.stat).toEqual({ added: 1, removed: 0 })

      act(() => held.release?.())
      await flush()

      expect(probe.stat).toEqual({ added: 1, removed: 0 })
    } finally {
      held.release?.()
      await done()
    }
  })
})
