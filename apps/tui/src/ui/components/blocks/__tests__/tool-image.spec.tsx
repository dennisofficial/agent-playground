import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { testRender } from '@opentui/react/test-utils'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React from 'react'

import type { ToolCall } from '../../../../store'
import { applyTranscriptCovered } from '../../../covered-store'
import { applyTranscriptRows } from '../../../viewport-rows-store'
import { encodePng } from '../../../images/__tests__/png-fixture'
import { ToolImage } from '../tool-image'

const directory = mkdtempSync(join(tmpdir(), 'atlas-tool-image-'))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

afterEach(() => applyTranscriptCovered(false))

// Both stores are module-global and the app publishes into them; pin them so shard order cannot move them.
beforeEach(() => {
  applyTranscriptRows(24)
  applyTranscriptCovered(false)
})

const CRIMSON: readonly [number, number, number, number] = [220, 20, 60, 255]

const writeRedPng = (args: { name: string; width: number; height: number }): string => {
  const rgba = new Uint8Array(args.width * args.height * 4)
  for (let pixel = 0; pixel < args.width * args.height; pixel += 1) rgba.set(CRIMSON, pixel * 4)

  const path = join(directory, args.name)
  writeFileSync(
    path,
    encodePng({ width: args.width, height: args.height, colourType: 6, bytesPerPixel: 4, samples: rgba }),
  )
  return path
}

const readCall = (args: {
  path: string
  mediaType: string
  width: number
  height: number
}): ToolCall =>
  ({
    callId: 'call-1',
    name: 'read',
    input: { path: args.path },
    output: {
      path: args.path,
      mediaType: args.mediaType,
      width: args.width,
      height: args.height,
      byteLength: 1024,
      inlined: true,
    },
    settled: true,
    failed: false,
  }) as unknown as ToolCall

const settle = async (flush: () => Promise<void>): Promise<void> => {
  for (let pass = 0; pass < 8; pass += 1) {
    await Bun.sleep(1)
    await flush()
  }
}

describe('an opened image read', () => {
  test('paints the picture, not just its name', async () => {
    const path = writeRedPng({ name: 'shot.png', width: 32, height: 32 })
    const { renderOnce, flush, captureCharFrame } = await testRender(
      <ToolImage call={readCall({ path, mediaType: 'image/png', width: 32, height: 32 })} inner={40} cwd={directory} />,
      { width: 44, height: 20 },
    )

    await renderOnce()
    await settle(flush)

    const frame = captureCharFrame()

    expect(frame).toContain('shot.png')
    expect(frame).toContain('█')
  })

  test('paints a format our own decoder never handled, because the renderer decodes natively', async () => {
    const path = writeRedPng({ name: 'photo.jpg', width: 16, height: 16 })
    const { renderOnce, flush, captureCharFrame } = await testRender(
      <ToolImage
        call={readCall({ path, mediaType: 'image/jpeg', width: 16, height: 16 })}
        inner={40}
        cwd={directory}
      />,
      { width: 44, height: 20 },
    )

    await renderOnce()
    await settle(flush)

    const frame = captureCharFrame()

    expect(frame).toContain('photo.jpg')
    expect(frame).toContain('█')
  })

  test('says nothing at all for a read that was not an image', async () => {
    const notAnImage = {
      callId: 'call-1',
      name: 'read',
      output: { path: '/repo/a.ts', lines: 12 },
      settled: true,
      failed: false,
    } as unknown as ToolCall

    const { renderOnce, flush, captureCharFrame } = await testRender(
      <ToolImage call={notAnImage} inner={40} cwd={directory} />,
      { width: 44, height: 6 },
    )

    await renderOnce()
    await settle(flush)

    expect(captureCharFrame().trim()).toBe('')
  })
})

describe('an image under an overlay', () => {
  test('is withheld, because a kitty image paints over whatever is layered above it', async () => {
    const path = writeRedPng({ name: 'covered.png', width: 32, height: 32 })
    applyTranscriptCovered(true)

    const { renderOnce, flush, captureCharFrame } = await testRender(
      <ToolImage
        call={readCall({ path, mediaType: 'image/png', width: 32, height: 32 })}
        inner={40}
        cwd={directory}
      />,
      { width: 44, height: 20 },
    )

    await renderOnce()
    await settle(flush)

    const frame = captureCharFrame()

    expect(frame).toContain('covered.png')
    expect(frame).not.toContain('\u2588')
  })
})
