import { describe, expect, it } from 'bun:test'

import { EUsageWindow, NO_USAGE, worstWindow } from '../window'

const window = (utilization: number) => ({ utilization, resetsAt: null })

describe('worstWindow', () => {
  it('keeps the window closest to stopping the work', () => {
    expect(worstWindow([window(7), window(61), window(40)])).toEqual(window(61))
  })

  it('ignores the windows the account does not have', () => {
    expect(worstWindow([null, window(12), null])).toEqual(window(12))
  })

  it('reports nothing when the account has no such window at all', () => {
    expect(worstWindow([null, null])).toBeNull()
    expect(worstWindow([])).toBeNull()
  })
})

describe('NO_USAGE', () => {
  it('reads as never polled rather than as an idle account', () => {
    expect(NO_USAGE[EUsageWindow.FiveHour]).toBeNull()
    expect(NO_USAGE[EUsageWindow.SevenDay]).toBeNull()
  })
})
