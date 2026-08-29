import { describe, expect, it } from 'bun:test'

import { bootStepLabel, createBootProgress, EBootStep } from '../boot-progress'

describe('createBootProgress', () => {
  it('starts on the first thing the boot does', () => {
    expect(createBootProgress().step()).toBe(EBootStep.Composing)
  })

  it('tells its listeners each time the boot moves on', () => {
    const progress = createBootProgress()
    const seen: EBootStep[] = []
    const unsubscribe = progress.subscribe(() => seen.push(progress.step()))

    progress.report(EBootStep.Authorising)
    progress.report(EBootStep.Opening)
    unsubscribe()
    progress.report(EBootStep.Ready)

    expect(seen).toEqual([EBootStep.Authorising, EBootStep.Opening])
    expect(progress.step()).toBe(EBootStep.Ready)
  })

  it('says nothing when the step it was given is the one it is already on', () => {
    const progress = createBootProgress()
    let calls = 0
    const unsubscribe = progress.subscribe(() => {
      calls += 1
    })

    progress.report(EBootStep.Composing)
    unsubscribe()

    expect(calls).toBe(0)
  })
})

describe('bootStepLabel', () => {
  it('names every step in words the curtain can show', () => {
    for (const step of Object.values(EBootStep)) {
      expect(bootStepLabel(step).length).toBeGreaterThan(0)
    }
  })
})
