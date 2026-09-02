import { describe, expect, it } from 'bun:test'

import { critiqueRequestOf } from '../critique'
import { ERiskDimension } from '../dimension'
import { DEFAULT_CLASSIFIER_POLICY } from '../triage'

const requestFor = (environment: readonly string[], muted: readonly ERiskDimension[] = []) =>
  critiqueRequestOf({ policy: { ...DEFAULT_CLASSIFIER_POLICY, environment, muted } })

describe('the critique of the configuration itself', () => {
  it('hands over the environment the operator configured, fenced as data', () => {
    const request = requestFor(['Production is anything named prod.'])

    expect(request.prompt).toContain('Production is anything named prod.')
    expect(request.prompt).toContain('<untrusted-content source="environment">')
    expect(request.system).toContain('READS AS PERMISSION')
  })

  it('says so plainly when no trust boundary is configured at all', () => {
    expect(requestFor([]).prompt).toContain('no trust boundary')
  })

  it('names every dimension, and marks the ones switched off', () => {
    const request = requestFor([], [ERiskDimension.Exposure])

    for (const dimension of Object.values(ERiskDimension)) {
      expect(request.prompt).toContain(`- ${dimension}`)
    }
    expect(request.prompt).toContain(`- ${ERiskDimension.Exposure} (switched off)`)
    expect(request.prompt).toContain(`dimensions switched off entirely: ${ERiskDimension.Exposure}`)
  })

  it('states the thresholds an interruption depends on', () => {
    const request = requestFor([])

    expect(request.prompt).toContain(
      `at most ${DEFAULT_CLASSIFIER_POLICY.asksPerThread} interruptions`,
    )
    expect(request.prompt).toContain(DEFAULT_CLASSIFIER_POLICY.consultAtOrAbove)
  })
})
