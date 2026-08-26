import { describe, expect, it } from 'bun:test'

import { activateSetting, adjustSetting } from '../edit'
import { choice, range, toggle } from './fixture'

describe('activateSetting', () => {
  it('flips a toggle', () => {
    expect(activateSetting({ definition: toggle, current: true })).toBe(false)
    expect(activateSetting({ definition: toggle, current: false })).toBe(true)
  })

  it('walks a choice round the options', () => {
    expect(activateSetting({ definition: choice, current: 'ask' })).toBe('never')
    expect(activateSetting({ definition: choice, current: 'always' })).toBe('ask')
  })

  it('walks a range by its step and wraps at the top', () => {
    expect(activateSetting({ definition: range, current: 40 })).toBe(45)
    expect(activateSetting({ definition: range, current: 50 })).toBe(30)
  })

  it('recovers to the fallback when the held value is the wrong shape', () => {
    expect(activateSetting({ definition: range, current: 'forty' })).toBe(45)
    expect(activateSetting({ definition: choice, current: 12 })).toBe('never')
  })
})

describe('adjustSetting', () => {
  it('stops a choice at each end rather than wrapping', () => {
    expect(adjustSetting({ definition: choice, current: 'ask', delta: -1 })).toBe('ask')
    expect(adjustSetting({ definition: choice, current: 'always', delta: 1 })).toBe('always')
    expect(adjustSetting({ definition: choice, current: 'ask', delta: 2 })).toBe('always')
  })

  it('stops a range at its bounds', () => {
    expect(adjustSetting({ definition: range, current: 30, delta: -1 })).toBe(30)
    expect(adjustSetting({ definition: range, current: 50, delta: 1 })).toBe(50)
    expect(adjustSetting({ definition: range, current: 40, delta: 1 })).toBe(45)
  })

  it('reads a direction as on or off for a toggle', () => {
    expect(adjustSetting({ definition: toggle, current: true, delta: -1 })).toBe(false)
    expect(adjustSetting({ definition: toggle, current: false, delta: 1 })).toBe(true)
    expect(adjustSetting({ definition: toggle, current: false, delta: 0 })).toBe(false)
  })
})
