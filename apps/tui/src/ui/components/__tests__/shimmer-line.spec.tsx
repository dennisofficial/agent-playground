import { ERetryReason } from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { afterAll, describe, expect, test } from 'bun:test'
import React from 'react'

import { WorkingLine, EWorkingVerb } from '../working-line'

const QUIET_MS = 400

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type Setup = Awaited<ReturnType<typeof testRender>>

const mounted: Setup[] = []

afterAll(async () => {
  for (const setup of mounted) setup.renderer.destroy()
})

/**
 * The shimmer is the working cue across many tiles, so it runs in every one of them — which is why
 * a tick must be a write into the text buffer and never a React render.
 */
describe('a shimmer line left running', () => {
  test('keeps drawing frames without re-rendering its component', async () => {
    let renders = 0
    const Counted = (props: { elapsedMs: number; outputTokens: number }): React.ReactNode => {
      renders += 1
      return <WorkingLine elapsedMs={props.elapsedMs} outputTokens={props.outputTokens} interrupting={false} verb={EWorkingVerb.Thinking} />
    }
    const setup = await testRender(<Counted elapsedMs={1000} outputTokens={100} />, { width: 100, height: 10 })
    mounted.push(setup)
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
    await setup.flush()

    expect(setup.captureCharFrame()).toContain('Thinking for 1s')

    const framesBefore = setup.renderer.getStats().frameCount
    const rendersBefore = renders
    await sleep(QUIET_MS)
    const frames = setup.renderer.getStats().frameCount - framesBefore

    expect(frames).toBeGreaterThan(3)
    expect(renders).toBe(rendersBefore)
  })

  test('stops drawing once the line is gone', async () => {
    const setup = await testRender(
      <WorkingLine elapsedMs={1000} outputTokens={100} interrupting={false} />,
      { width: 100, height: 10 },
    )
    mounted.push(setup)
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
    await setup.flush()
    await sleep(QUIET_MS)

    const framesBefore = setup.renderer.getStats().frameCount
    await sleep(QUIET_MS)
    expect(setup.renderer.getStats().frameCount).toBeGreaterThan(framesBefore)
  })

  test('shows the retry countdown in the error colour', async () => {
    const setup = await testRender(
      <WorkingLine
        elapsedMs={1000}
        outputTokens={0}
        interrupting={false}
        retry={{ attempt: 2, maxAttempts: 5, delayMs: 30_000, reason: ERetryReason.RateLimited, startedAt: Date.now() }}
      />,
      { width: 100, height: 10 },
    )
    mounted.push(setup)
    await setup.flush()
    const frame = setup.captureCharFrame()
    expect(frame).toMatch(/retry/i)
  })
})
