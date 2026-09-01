import { describe, expect, it } from 'bun:test'

import { checksRollup, checksTally, ECheckOutcome } from '../checks'
import { EChecksState } from '../pull-request'

describe('checksRollup', () => {
  it('is none with nothing to roll up', () => {
    expect(checksRollup([])).toBe(EChecksState.None)
  })

  it('is failing when one failure hides among passes', () => {
    expect(
      checksRollup([
        ECheckOutcome.Passed,
        ECheckOutcome.Passed,
        ECheckOutcome.Failed,
        ECheckOutcome.Passed,
      ]),
    ).toBe(EChecksState.Failing)
  })

  it('is running while a pass and a run coexist', () => {
    expect(checksRollup([ECheckOutcome.Passed, ECheckOutcome.Running])).toBe(EChecksState.Running)
  })

  it('is failing rather than running when both are present', () => {
    expect(checksRollup([ECheckOutcome.Running, ECheckOutcome.Failed])).toBe(EChecksState.Failing)
  })

  it('is none when everything is ignored', () => {
    expect(checksRollup([ECheckOutcome.Ignored, ECheckOutcome.Ignored])).toBe(EChecksState.None)
  })
})

describe('checksTally', () => {
  it('counts each outcome and leaves the ignored ones out', () => {
    expect(
      checksTally([
        ECheckOutcome.Passed,
        ECheckOutcome.Passed,
        ECheckOutcome.Failed,
        ECheckOutcome.Running,
        ECheckOutcome.Ignored,
      ]),
    ).toEqual({ running: 1, passed: 2, failed: 1 })
  })

  it('is all zeroes with nothing to count', () => {
    expect(checksTally([])).toEqual({ running: 0, passed: 0, failed: 0 })
  })
})
