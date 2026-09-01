import { afterEach, describe, expect, test } from 'bun:test'
import { testRender } from '@opentui/react/test-utils'
import React from 'react'

import { applyTranscriptBounds } from '../../viewport-rows-store'
import '../transcript-image'

const PATH = `${process.env.HOME}/atlas-images/radial-sky.png`

/** Any of the quadrant glyphs the block sampler paints with; a gradient need not produce a solid one. */
const painted = (frame: string): boolean => /[\u2580-\u259f]/.test(frame)

afterEach(() => applyTranscriptBounds({ top: 0, rows: 0 }))

const settle = async (flush: () => Promise<void>): Promise<void> => {
  for (let pass = 0; pass < 10; pass += 1) {
    await Bun.sleep(3)
    await flush()
  }
}

const paint = async (): Promise<string> => {
  const { renderOnce, flush, captureCharFrame } = await testRender(
    <box paddingTop={2} flexDirection="column">
      <transcript-image source={PATH} protocol="blocks" fit="fit" style={{ width: 10, height: 5 }} />
    </box>,
    { width: 20, height: 12 },
  )
  await renderOnce()
  await settle(flush)
  return captureCharFrame()
}

describe('a transcript picture', () => {
  test('paints when the whole of it is inside the viewport', async () => {
    applyTranscriptBounds({ top: 0, rows: 12 })

    expect(painted(await paint())).toBe(true)
  })

  test('withholds itself rather than asking for a crop Warp would ignore', async () => {
    applyTranscriptBounds({ top: 4, rows: 8 })

    expect(painted(await paint())).toBe(false)
  })

  test('withholds itself when its bottom runs past the viewport too', async () => {
    applyTranscriptBounds({ top: 0, rows: 4 })

    expect(painted(await paint())).toBe(false)
  })

  test('paints when nothing has measured the transcript yet', async () => {
    applyTranscriptBounds({ top: 0, rows: 0 })

    expect(painted(await paint())).toBe(true)
  })
})
