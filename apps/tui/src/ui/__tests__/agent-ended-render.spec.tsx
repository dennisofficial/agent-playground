import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { EAuthor, EEntryKind, EPendingKind, type AgentEndedEntry } from '../../store'
import { PendingBlock } from '../components/blocks/pending-block'
import { EntryView } from '../components/entry-view'
import { teardown } from '../markdown/__tests__/harness'

const WIDE = { width: 120, height: 30 }

const REPORT = ['## What I found', '', 'Every call site is in the loop package.'].join('\n')

const HEADLINE = 'Sub-agent explore "audit the credential vault" finished after 3 turns'

const ended = (over: Partial<AgentEndedEntry> = {}): AgentEndedEntry => ({
  kind: EEntryKind.AgentEnded,
  author: EAuthor.Model,
  key: 'e1',
  text: `${HEADLINE} and 12 tool calls`,
  agentId: 'thread-child',
  report: REPORT,
  failed: false,
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

describe('a sub-agent ending in the scrollback', () => {
  it('shows the ending alone, with the report behind an affordance', async () => {
    const frame = await shown(<EntryView entry={ended()} width={110} />)

    expect(frame).toContain(HEADLINE)
    expect(frame).toContain('↵ report')
    expect(frame).not.toContain('Every call site')
  })

  it('shows the whole report once it is opened, and drops the affordance', async () => {
    const frame = await shown(<EntryView entry={ended()} width={110} expanded />)

    expect(frame).toContain('Every call site is in the loop package.')
    expect(frame).not.toContain('↵ report')
  })

  it('says the child reported nothing rather than offering an empty fold', async () => {
    const frame = await shown(<EntryView entry={ended({ report: '' })} width={110} />)

    expect(frame).toContain('reported nothing')
    expect(frame).not.toContain('↵ report')
  })

  it('waits under the working indicator as a notice, not as something a human typed', async () => {
    const frame = await shown(
      <PendingBlock
        rows={[
          {
            kind: EPendingKind.Agent,
            id: 'agent-finished-thread-child',
            text: `${HEADLINE} and 12 tool calls`,
            failed: false,
          },
        ]}
        width={110}
      />,
    )

    expect(frame).toContain(HEADLINE)
    expect(frame).toContain('queued')
  })
})
