import { test } from 'bun:test'
import { testRender } from '@opentui/react/test-utils'
import React from 'react'

const PATH = `${process.env.HOME}/atlas-images/radial-sky.png`  // 1600x1600 square

const find = (r: any): any => {
  if (r?.constructor?.name === 'ImageRenderable') return r
  for (const c of r?.getChildren?.() ?? []) { const f = find(c); if (f) return f }
  return null
}

const settle = async (flush: () => Promise<void>) => {
  for (let i = 0; i < 10; i++) { await Bun.sleep(3); await flush() }
}

for (const [w, h, cols, rows] of [[200, 60, 60, 30], [200, 60, 196, 30], [80, 24, 60, 30]] as const) {
  test(`term ${w}x${h}, asked ${cols}x${rows}`, async () => {
    const { renderer, renderOnce, flush } = await testRender(
      <box flexDirection="column" flexShrink={0}>
        <text>label</text>
        <box paddingLeft={4} flexShrink={0}>
          <image source={PATH} protocol="blocks" fit="fit" style={{ width: cols, height: rows }} />
        </box>
      </box>,
      { width: w, height: h },
    )
    await renderOnce(); await settle(flush)
    const img = find(renderer.root)
    const fitted = img?.getFittedSize?.(img.width, img.height)
    console.log(
      `asked ${cols}x${rows} -> laid out ${img?.width}x${img?.height}` +
      `  cellAspect=${img?.cellAspectRatio}  fitted=${fitted?.width}x${fitted?.height}` +
      `  onscreen-aspect=${fitted ? (fitted.width / (fitted.height * (img.cellAspectRatio||2))).toFixed(2) : '?'} (1.00 = square)`,
    )
  })
}
