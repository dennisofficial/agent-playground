import { ImageRenderable, type OptimizedBuffer } from '@opentui/core'
import { extend } from '@opentui/react'

import { transcriptRows, transcriptTop } from '../viewport-rows-store'

/**
 * A picture that shows itself only while all of it fits on screen.
 *
 * Warp accepts a kitty placement's cell box but discards its source rectangle, so a half-scrolled
 * image arrives as the whole picture crushed into the rows that remain rather than as the crop that
 * was asked for. Measured on Warp v0.2026.08.19: a placement of `y=200,h=200` against a four-band
 * image painted all four bands, not the requested bottom half.
 *
 * Nothing can be done about that from here except decline to ask for a crop. Since a transcript
 * image is already held shorter than the viewport, there is always a scroll position that shows the
 * whole thing, and withholding it either side of that reads as scrolling away rather than melting.
 */
export class TranscriptImageRenderable extends ImageRenderable {
  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (this.wouldBeCropped()) return
    super.renderSelf(buffer)
  }

  private wouldBeCropped(): boolean {
    const rows = transcriptRows()
    if (rows < 1) return false

    const top = transcriptTop()
    return this.y < top || this.y + this.height > top + rows
  }
}

declare module '@opentui/react' {
  interface OpenTUIComponents {
    'transcript-image': typeof TranscriptImageRenderable
  }
}

extend({ 'transcript-image': TranscriptImageRenderable })
