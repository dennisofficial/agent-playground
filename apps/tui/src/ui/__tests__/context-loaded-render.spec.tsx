import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { EAuthor, EEntryKind, type ContextLoadedEntry } from '../../store'
import { EntryView } from '../components/entry-view'
import { teardown } from '../markdown/__tests__/harness'

const WIDE = { width: 120, height: 30 }

const injected = (over: Partial<ContextLoadedEntry> = {}): ContextLoadedEntry => ({
  kind: EEntryKind.ContextLoaded,
  author: EAuthor.Model,
  key: 'e1',
  text: 'Context: gitState',
  body: 'gitState\nbranch: main, 3 files dirty',
  ...over,
})

async function shown(node: React.ReactNode): Promise<string> {
  const setup = await testRender(<box flexDirection="column">{node}</box>, WIDE)
  try {
    await setup.flush()
    return setup.captureCharFrame()
  } finally {
    await teardown(setup)
  }
}

describe('context a hook injected, in the scrollback', () => {
  it('shows the one-liner with an affordance and keeps the injected text folded', async () => {
    const frame = await shown(<EntryView entry={injected()} width={110} />)

    expect(frame).toContain('Context: gitState')
    expect(frame).toContain('↵ context')
    expect(frame).not.toContain('3 files dirty')
  })

  it('shows the injected text once opened, and drops the affordance', async () => {
    const frame = await shown(<EntryView entry={injected()} width={110} expanded />)

    expect(frame).toContain('branch: main, 3 files dirty')
    expect(frame).not.toContain('↵ context')
  })

  it('admits when the hook injected nothing rather than offering an empty fold', async () => {
    const frame = await shown(<EntryView entry={injected({ body: '' })} width={110} />)

    expect(frame).toContain('was empty')
    expect(frame).not.toContain('↵ context')
  })
})
