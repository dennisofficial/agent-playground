import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { CompactedBlock } from '../components/blocks/compacted-block'
import { grammarsReady, settle, teardown } from '../markdown/__tests__/harness'

await grammarsReady()

const SUMMARY = [
  'Notes to self, picking up this task:',
  '',
  '**Operator ask:** explore the TUI and list what is missing.',
  '',
  '- Repo root is `/repo`',
  '- The catalog lives in `registry.ts`',
].join('\n')

const WIDE = { width: 120, height: 30 }

async function shown(props: { expanded: boolean }) {
  const setup = await testRender(
    <CompactedBlock text={SUMMARY} width={110} compactedEntries={154} expanded={props.expanded} />,
    WIDE,
  )
  await setup.flush()
  await settle(80)
  await setup.flush()
  return setup
}

describe('the compaction divider', () => {
  it('shows only the divider until it is opened', async () => {
    const setup = await shown({ expanded: false })

    try {
      const frame = setup.captureCharFrame()
      expect(frame).toContain('context compacted · 154 earlier entries summarised')
      expect(frame).toContain('summary hidden')
      expect(frame).not.toContain('Notes to self')
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('renders the summary as markdown once opened, rather than as its source', async () => {
    const setup = await shown({ expanded: true })

    try {
      const frame = setup.captureCharFrame()
      expect(frame).toContain('Notes to self')
      expect(frame).toContain('Operator ask:')
      expect(frame).not.toContain('**Operator ask:**')
      expect(frame).not.toContain('summary hidden')
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('says one entry rather than 1 entries', async () => {
    const setup = await testRender(
      <CompactedBlock text={SUMMARY} width={110} compactedEntries={1} />,
      WIDE,
    )

    try {
      await setup.flush()
      expect(setup.captureCharFrame()).toContain('1 earlier entry summarised')
    } finally {
      await teardown(setup)
    }
  }, 30_000)
})
