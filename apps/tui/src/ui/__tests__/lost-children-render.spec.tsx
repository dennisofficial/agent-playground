import { toThreadId } from '@dltech/atlas-core'
import type { RecoveredAgents } from '@dltech/atlas-harness'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { LostChildren } from '../components/lost-children'
import { frameOf } from './transcript-fixture'

const WIDE = 110

const NOTHING: RecoveredAgents = { settled: [], unlogged: [] }

const LOST: RecoveredAgents = {
  settled: [],
  unlogged: [
    {
      agentId: toThreadId('thr_orphan'),
      agentType: 'explore',
      title: 'explore (vault audit)',
      startedAt: '2026-01-01T09:15:00.000Z',
    },
  ],
}

const framed = (lost: RecoveredAgents | null, width = WIDE): Promise<string> =>
  frameOf(<LostChildren width={width} lost={lost} />, width)

describe('the lost sub-agents notice', () => {
  it('names the child that was lost', async () => {
    expect(await framed(LOST)).toContain('explore (vault audit)')
  })

  it('says the working tree may have moved under the operator', async () => {
    const frame = await framed(LOST)

    expect(frame).toContain('may have changed files')
    expect(frame).toContain('check the tree')
  })

  it('says plainly that nothing was resumed and nothing can be', async () => {
    const frame = await framed(LOST)

    expect(frame).toContain('Nothing here can be resumed')
    expect(frame).toContain('Nothing was resumed for you')
  })

  it('counts what it found', async () => {
    expect(await framed(LOST)).toContain('1 sub-agent')
  })

  it('draws nothing whatsoever when nothing was lost', async () => {
    const clean = await framed(NOTHING)

    expect(clean).not.toContain('sub-agent')
    expect(clean).not.toContain('check the tree')
    expect(clean.trim()).toBe('')
  })

  it('draws nothing when the open reported no recovery at all', async () => {
    expect((await framed(null)).trim()).toBe('')
  })

  it('keeps the name readable at the narrow end', async () => {
    expect(await framed(LOST, 60)).toContain('explore (vault audit)')
  })
})
