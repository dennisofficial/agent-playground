import { useRenderer } from '@opentui/react'
import React, { useEffect, useRef, useState } from 'react'

import { copyToClipboard } from '../clipboard'
import { useClickRegion } from '../hooks/use-click-region'
import { glyph, theme } from '../theme'

const CONFIRM_MS = 1500

const LABELS = {
  idle: `${glyph.copy} copy`,
  copied: `${glyph.copy} copied`,
  failed: `${glyph.copy} blocked`,
} as const

export const COPY_BUTTON_WIDTH =
  Math.max(...Object.values(LABELS).map((label) => label.length)) + 2

export function CopyButton(props: {
  text: string
  bg?: string
  revealed?: boolean
}): React.ReactNode {
  const renderer = useRenderer()
  const [state, setState] = useState<keyof typeof LABELS>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const handleCopy = (): void => {
    setState(copyToClipboard({ renderer, text: props.text }) ? 'copied' : 'failed')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), CONFIRM_MS)
  }

  const { handlers, hovered } = useClickRegion(handleCopy)

  const fg = restingColour({ state, hovered })

  const shown = (props.revealed ?? true) || state !== 'idle'
  const label = shown ? ` ${LABELS[state]} ` : ''

  return (
    <box
      flexDirection="row"
      justifyContent="flex-end"
      width={COPY_BUTTON_WIDTH}
      flexShrink={0}
    >
      {shown ? (
        <text
          fg={fg}
          selectable={false}
          {...(props.bg === undefined ? {} : { bg: props.bg })}
          {...handlers}
        >
          {label}
        </text>
      ) : null}
    </box>
  )
}

function restingColour(args: { state: keyof typeof LABELS; hovered: boolean }): string {
  if (args.state === 'failed') return theme.warn
  if (args.state === 'copied') return theme.ok
  return args.hovered ? theme.hover : theme.dim
}
