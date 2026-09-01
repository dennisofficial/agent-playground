import {
  EAccountOrigin,
  EAccountStatus,
  EAuthKind,
  EAuthProvider,
  EUsageWindow,
  toAccountId,
  type Account,
} from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { accountMeterSpans } from '../account-meters'
import {
  ACCOUNT_ROWS,
  EAccountRow,
  EAccountsView,
  rowLabel,
  type AccountRow,
  type AccountsState,
} from '../accounts-model'
import { Accounts } from '../components/accounts'
import { teardown } from '../markdown/__tests__/harness'

const TERMINAL_WIDTH = 80

const HEIGHT = 24

const NOW = 1_700_000_000_000

const WARN = { [EUsageWindow.FiveHour]: 80, [EUsageWindow.SevenDay]: 80 }

const account = (args: { id: string; label: string; origin: EAccountOrigin }): Account => ({
  id: toAccountId(args.id),
  provider: EAuthProvider.Anthropic,
  kind: EAuthKind.Oauth,
  origin: args.origin,
  label: args.label,
  status: EAccountStatus.Active,
  subscription: 'team',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

const IMPORTED = account({
  id: 'acc_imported',
  label: 'Claude Code (team)',
  origin: EAccountOrigin.Imported,
})

const LOGGED_IN = account({
  id: 'acc_login',
  label: 'dennis@trycomp.ai',
  origin: EAccountOrigin.Login,
})

const signedIn = (account: Account, active: boolean): AccountRow => ({
  kind: EAccountRow.Account,
  account,
  active,
})

const signedOut = (provider: EAuthProvider): AccountRow => ({
  kind: EAccountRow.SignedOut,
  provider,
  active: false,
})

const stateWith = (rows: readonly AccountRow[]): AccountsState => ({
  view: EAccountsView.List,
  index: 0,
  rows,
  prompt: null,
  typed: '',
  notice: null,
  failure: null,
  busy: false,
})

const METERED = accountMeterSpans({
  usage: {
    [EUsageWindow.FiveHour]: { utilization: 72, resetsAt: new Date(NOW + 4_500_000).toISOString() },
    [EUsageWindow.SevenDay]: { utilization: 30, resetsAt: null },
  },
  warn: WARN,
  now: NOW,
})

async function rowsOf(args: {
  state: AccountsState
  meters?: (row: AccountRow) => readonly (typeof METERED)[number][]
  width?: number
}): Promise<string[]> {
  const width = args.width ?? TERMINAL_WIDTH
  const setup = await testRender(
    <box flexDirection="column" width={width} height={HEIGHT}>
      <box flexGrow={1} />
      <Accounts
        width={width}
        state={args.state}
        overlay
        onPick={() => {}}
        onDismiss={() => {}}
        onOpenUrl={() => {}}
        {...(args.meters === undefined ? {} : { meters: args.meters })}
      />
    </box>,
    { width, height: HEIGHT },
  )

  try {
    await setup.flush()
    return setup.captureCharFrame().split('\n')
  } finally {
    await teardown(setup)
  }
}

const lineWith = (rows: readonly string[], text: string): string =>
  rows.find((row) => row.includes(text)) ?? ''

describe('an account row', () => {
  it('keeps the meter off the detail line, where the origin was crowding it out', async () => {
    const rows = await rowsOf({
      state: stateWith([signedIn(IMPORTED, true)]),
      meters: () => METERED,
    })

    const detail = lineWith(rows, 'imported')

    expect(detail).toContain('Anthropic · subscription · imported')
    expect(detail).not.toContain('5h')
    expect(detail).not.toContain('▰')
  })

  it('gives the meter a line of its own, with nothing of the detail on it', async () => {
    const rows = await rowsOf({
      state: stateWith([signedIn(IMPORTED, true)]),
      meters: () => METERED,
    })

    const meter = lineWith(rows, '▰')

    expect(meter).toContain('5h')
    expect(meter).toContain('wk')
    expect(meter).not.toContain('Anthropic')
  })

  it('renders the whole meter rather than clipping its tail', async () => {
    const rows = await rowsOf({
      state: stateWith([signedIn(IMPORTED, true)]),
      meters: () => METERED,
    })

    const meter = lineWith(rows, '▰')

    expect(meter).toContain('1h15m')
    expect(meter).toContain('30%')
  })

  it('spends no line on a meter that has nothing to show', async () => {
    const rows = await rowsOf({ state: stateWith([signedIn(LOGGED_IN, true)]) })

    const label = rows.findIndex((row) => row.includes('dennis@trycomp.ai'))
    const detail = rows.findIndex((row) => row.includes('Anthropic · subscription'))

    expect(detail).toBe(label + 1)
    expect(rows[detail + 1]).not.toContain('▱')
  })

  it('stacks three lines an account, and the next account under them', async () => {
    const rows = await rowsOf({
      state: stateWith([signedIn(IMPORTED, false), signedIn(LOGGED_IN, true)]),
      meters: () => METERED,
    })

    const first = rows.findIndex((row) => row.includes('Claude Code (team)'))
    const second = rows.findIndex((row) => row.includes('dennis@trycomp.ai'))

    expect(second).toBe(first + 3)
  })
})

describe('the accounts drawer', () => {
  it('rises from the bottom rather than hugging the side', async () => {
    const rows = await rowsOf({
      state: stateWith([signedIn(IMPORTED, true)]),
      meters: () => METERED,
    })

    const edge = rows.findIndex((row) => row.trimStart().startsWith('─'))

    expect(edge).toBeGreaterThan(rows.length / 2)
    expect(rows.findIndex((row) => row.includes('ACCOUNTS'))).toBeGreaterThan(edge)
  })

  it('rules off the whole width, not a sidebar column', async () => {
    const rows = await rowsOf({
      state: stateWith([signedIn(IMPORTED, true)]),
      meters: () => METERED,
      width: 96,
    })

    const edge = rows.find((row) => row.trimStart().startsWith('─')) ?? ''

    expect(edge.trimEnd().length).toBe(96)
  })

  it('has room for every hint the sidebar column used to drop', async () => {
    const rows = await rowsOf({
      state: stateWith([signedIn(IMPORTED, true)]),
      meters: () => METERED,
      width: 96,
    })

    const hints = lineWith(rows, 'esc')

    expect(hints).toContain('x remove')
    expect(hints).toContain('esc close')
  })

  it('bounds itself to a window rather than growing up the screen', async () => {
    const many = Array.from({ length: ACCOUNT_ROWS + 3 }, (_, at) =>
      signedIn(
        account({
          id: `acc_${at}`,
          label: `account-${at}@example.com`,
          origin: EAccountOrigin.Login,
        }),
        at === 0,
      ),
    )

    const rows = await rowsOf({ state: stateWith(many), meters: () => METERED, width: 96 })
    const shown = many.filter((row) => rows.some((line) => line.includes(rowLabel(row))))

    expect(shown).toHaveLength(ACCOUNT_ROWS)
    expect(lineWith(rows, 'more below')).toContain('3 more below')
  })
})
