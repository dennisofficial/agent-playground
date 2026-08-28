import { ECommandGroup, ECommandKind, type CommandSpec } from '@dltech/atlas-core'
import { KeyEvent } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { settle, teardown } from '../../ui/markdown/__tests__/harness'
import { useCommandMenu, type CommandMenuControl } from '../use-command-menu'

const SPECS: readonly CommandSpec[] = [
  {
    name: 'compact',
    kind: ECommandKind.Local,
    summary: 'replace the history so far with a summary',
    group: ECommandGroup.Context,
  },
  {
    name: 'clear',
    kind: ECommandKind.Local,
    summary: 'start a fresh conversation',
    group: ECommandGroup.Session,
  },
  {
    name: 'review',
    kind: ECommandKind.Skill,
    summary: 'review the working tree',
    group: ECommandGroup.Workspace,
  },
]

const press = (name: string): KeyEvent =>
  new KeyEvent({
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: '',
    number: false,
    raw: '',
    eventType: 'press',
    source: 'raw',
  })

const RENDER_MS = 60

type Probe = { control: CommandMenuControl | null; completions: string[] }

function Menu(props: { probe: Probe }): React.ReactNode {
  const control = useCommandMenu({
    specs: SPECS,
    onComplete: (text) => props.probe.completions.push(text),
  })
  props.probe.control = control

  return <text>{control.state === null ? 'closed' : `open ${control.state.index}`}</text>
}

const controlOf = (probe: Probe): CommandMenuControl => {
  if (probe.control === null) throw new Error('the probe never mounted')
  return probe.control
}

async function mounted(): Promise<{
  probe: Probe
  flush: () => Promise<void>
  done: () => Promise<void>
}> {
  const probe: Probe = { control: null, completions: [] }
  const setup = await testRender(<Menu probe={probe} />, { width: 60, height: 6 })
  await setup.flush()

  return {
    probe,
    flush: async () => {
      await settle(RENDER_MS)
      await setup.flush()
    },
    done: () => teardown(setup),
  }
}

describe('the command menu control', () => {
  it('stays closed until a token is typed', async () => {
    const { probe, done } = await mounted()

    try {
      expect(controlOf(probe).state).toBeNull()
    } finally {
      await done()
    }
  })

  it('opens on a token and closes again when nothing matches', async () => {
    const { probe, flush, done } = await mounted()

    try {
      controlOf(probe).handleTextChanged('/c')
      await flush()
      expect(controlOf(probe).state?.matches.map((spec) => spec.name)).toEqual([
        'compact',
        'clear',
      ])

      controlOf(probe).handleTextChanged('/czz')
      await flush()
      expect(controlOf(probe).state).toBeNull()
    } finally {
      await done()
    }
  })

  it('falls through every key while it is closed', async () => {
    const { probe, done } = await mounted()

    try {
      for (const name of ['up', 'down', 'tab', 'return', 'escape']) {
        expect(controlOf(probe).handleKey(press(name))).toBe(false)
      }
    } finally {
      await done()
    }
  })

  it('consumes the arrows and moves the selection', async () => {
    const { probe, flush, done } = await mounted()

    try {
      controlOf(probe).handleTextChanged('/c')
      await flush()

      expect(controlOf(probe).handleKey(press('down'))).toBe(true)
      await flush()
      expect(controlOf(probe).state?.index).toBe(1)

      expect(controlOf(probe).handleKey(press('up'))).toBe(true)
      await flush()
      expect(controlOf(probe).state?.index).toBe(0)
    } finally {
      await done()
    }
  })

  it('completes the selection on tab and closes', async () => {
    const { probe, flush, done } = await mounted()

    try {
      controlOf(probe).handleTextChanged('run /rev')
      await flush()

      expect(controlOf(probe).handleKey(press('tab'))).toBe(true)
      await flush()

      expect(probe.completions).toEqual(['run /review '])
      expect(controlOf(probe).state).toBeNull()
    } finally {
      await done()
    }
  })

  it('completes on return rather than letting the draft send', async () => {
    const { probe, flush, done } = await mounted()

    try {
      controlOf(probe).handleTextChanged('/comp')
      await flush()

      expect(controlOf(probe).handleKey(press('return'))).toBe(true)
      await flush()

      expect(probe.completions).toEqual(['/compact '])
    } finally {
      await done()
    }
  })

  it('dismisses on escape without completing', async () => {
    const { probe, flush, done } = await mounted()

    try {
      controlOf(probe).handleTextChanged('/c')
      await flush()

      expect(controlOf(probe).handleKey(press('escape'))).toBe(true)
      await flush()

      expect(controlOf(probe).state).toBeNull()
      expect(probe.completions).toEqual([])
    } finally {
      await done()
    }
  })

  it('closes on demand', async () => {
    const { probe, flush, done } = await mounted()

    try {
      controlOf(probe).handleTextChanged('/c')
      await flush()

      controlOf(probe).handleDismiss()
      await flush()

      expect(controlOf(probe).state).toBeNull()
    } finally {
      await done()
    }
  })
})
