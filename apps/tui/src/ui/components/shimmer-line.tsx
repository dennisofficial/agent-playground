import { TextNodeRenderable, type TextRenderable } from '@opentui/core'
import React, { useEffect, useRef } from 'react'

import { useAppearance } from '../hooks/use-appearance'
import { subscribeTicker } from '../hooks/use-shimmer-clock'
import { shimmerText, SHIMMER_TICK_MS } from '../shimmer-frames'
import { spinnerFrame, SPINNER_FRAME_MS, theme } from '../theme'

/**
 * A tick writes the next StyledText straight into the buffer rather than rendering through React:
 * the crest moves every 40 ms and the label follows the parent's own cadence, so a render here
 * would be the frame's whole cost with nothing new to say.
 */
export function ShimmerLine(props: { label: string; base?: string | undefined }): React.ReactNode {
  useAppearance()
  const ref = useRef<TextRenderable>(null)
  const latest = useRef(props)
  latest.current = props

  useEffect(() => {
    const paint = (now: number): void => {
      const node = ref.current
      if (node !== null) {
        node.content = shimmerText({ label: latest.current.label, base: latest.current.base, now })
      }
    }
    paint(Date.now())
    return subscribeTicker({ intervalMs: SHIMMER_TICK_MS, onTick: paint })
  }, [])

  return <text ref={ref} content={shimmerText({ label: props.label, base: props.base, now: Date.now() })} />
}

export function SpinnerGlyph(props: { fg?: string | undefined }): React.ReactNode {
  const ref = useRef<TextNodeRenderable>(null)

  useEffect(() => {
    const write = (now: number): void => {
      const node = ref.current
      if (node !== null) node.children = [spinnerFrame(now)]
    }
    write(Date.now())
    return subscribeTicker({ intervalMs: SPINNER_FRAME_MS, onTick: write })
  }, [])

  return (
    <span ref={ref} fg={props.fg ?? theme.accent}>
      {spinnerFrame(Date.now())}
    </span>
  )
}
