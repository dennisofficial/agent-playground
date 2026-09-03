import { EGrantScope, ERiskDimension, type Grant } from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act } from 'react'

import { IDLE_SIDEBAR, type SidebarModel } from '../../store/sidebar-model'
import { Sidebar } from '../components/sidebar'
import { GRANTS_HEADING, REVOKE_NOTE } from '../components/sidebar/grants'
import { teardown } from '../markdown/__tests__/harness'
import { SIDEBAR_WIDTH } from '../theme'

const TERMINAL_WIDTH = 80

const HEIGHT = 30

const CWD = '/Users/dennis/Developer/atlas'

const GRANTS: readonly Grant[] = [
  {
    grantId: 'grant:call-1:worktree:eng-412-sidebar',
    dimensions: [ERiskDimension.Contention, ERiskDimension.Reach],
    scope: EGrantScope.Thread,
    subject: 'worktree:eng-412-sidebar',
    reason: 'the operator chose to stop being asked about this',
    seq: 7,
  },
]

const WITH_GRANTS: SidebarModel = { ...IDLE_SIDEBAR, grants: GRANTS }

async function mounted(args: { model: SidebarModel; onRevoke?: (grantId: string) => void }) {
  const setup = await testRender(
    <box flexDirection="row" width={TERMINAL_WIDTH} height={HEIGHT}>
      <Sidebar
        width={SIDEBAR_WIDTH}
        model={args.model}
        root={CWD}
        worktree={null}
        {...(args.onRevoke === undefined ? {} : { onRevokeGrant: args.onRevoke })}
      />
    </box>,
    { width: TERMINAL_WIDTH, height: HEIGHT },
  )

  await setup.flush()
  return setup
}

const rowsOf = (frame: string): string[] => frame.split('\n')

describe('the grants the operator has already given', () => {
  it('names each one by subject and dimension, so none of them is silent', async () => {
    const setup = await mounted({ model: WITH_GRANTS })

    try {
      const rows = rowsOf(setup.captureCharFrame())

      expect(rows.some((line) => line.includes(GRANTS_HEADING.toUpperCase()))).toBe(true)
      expect(rows.some((line) => line.includes('worktree:eng-412-sidebar'))).toBe(true)
      expect(rows.some((line) => line.includes('contention, reach'))).toBe(true)
      expect(rows.some((line) => line.includes(REVOKE_NOTE))).toBe(true)
    } finally {
      await teardown(setup)
    }
  })

  it('takes its heading with it when the thread has given none', async () => {
    const setup = await mounted({ model: IDLE_SIDEBAR })

    try {
      expect(setup.captureCharFrame()).not.toContain(GRANTS_HEADING.toUpperCase())
    } finally {
      await teardown(setup)
    }
  })

  it('hands back the grant that was clicked, which is what revocation names', async () => {
    const revoked: string[] = []
    const setup = await mounted({ model: WITH_GRANTS, onRevoke: (id) => revoked.push(id) })

    try {
      const rows = rowsOf(setup.captureCharFrame())
      const line = rows.findIndex((row) => row.includes('worktree:eng-412-sidebar'))
      const column = (rows[line] ?? '').indexOf('worktree:eng-412-sidebar') + 2

      expect(line).toBeGreaterThan(-1)

      await act(async () => {
        await setup.mockMouse.click(column, line)
      })
      await setup.flush()

      expect(revoked).toEqual(['grant:call-1:worktree:eng-412-sidebar'])
    } finally {
      await teardown(setup)
    }
  })
})
