import React from 'react'

import { useClickRegion } from '../../hooks/use-click-region'
import {
  EKeyGroup,
  EKeyLayer,
  spellChord,
  useKeyBindings,
  type KeyDeclaration,
} from '../../keys'
import { formatElapsed, formatTokens, glyph, theme, TRANSCRIPT_INSET } from '../../theme'
import { Panel } from '../panel'
import { Spans } from '../spans'
import type { Span } from '../spans'

const HEADING = 'failed'

const SEPARATOR = ' · '

const RETRY: KeyDeclaration = {
  chord: 'ctrl+r',
  hint: 'retry',
  describe: 'retry a failed turn',
}

const costOf = (args: { durationMs?: number; outputTokens?: number }): string => {
  const parts: string[] = []
  if (args.durationMs !== undefined) parts.push(formatElapsed(args.durationMs))
  if (args.outputTokens !== undefined && args.outputTokens > 0) {
    parts.push(`↓ ${formatTokens(args.outputTokens)}`)
  }
  return parts.join(SEPARATOR)
}

function Header(props: { cost: string }): React.ReactNode {
  return (
    <>
      <text fg={theme.error} bg={theme.panelBg}>{`${glyph.failed} ${HEADING}`}</text>
      <box flexGrow={1} />
      {props.cost.length === 0 ? null : (
        <text fg={theme.hint} bg={theme.panelBg}>
          {props.cost}
        </text>
      )}
    </>
  )
}

const retrySpans = (hovered: boolean): readonly Span[] => [
  { text: `${glyph.retry} ${spellChord(RETRY.chord)}`, fg: theme.accent },
  { text: ` ${RETRY.hint}`, fg: hovered ? theme.hover : theme.hint },
]

/**
 * The failed reading of the waiting-on-you slab: rail says who owns it, the band says what kind,
 * the body is the exact thing that happened, the last row is the keys.
 */
export function ErrorBlock(props: {
  message: string
  width: number
  durationMs?: number
  outputTokens?: number
  onRetry?: () => void
}): React.ReactNode {
  const retry = useClickRegion(props.onRetry)
  const onRetry = props.onRetry

  useKeyBindings(
    onRetry === undefined
      ? []
      : [{ ...RETRY, layer: EKeyLayer.Block, group: EKeyGroup.Turn, run: onRetry }],
  )

  return (
    <box flexDirection="column" marginBottom={1} flexShrink={0}>
      <Panel
        rail={theme.error}
        fill={theme.overlayBg}
        band={theme.panelBg}
        width={Math.max(1, props.width - TRANSCRIPT_INSET)}
        header={<Header cost={costOf(props)} />}
      >
        <text fg={theme.body} bg={theme.overlayBg}>
          {props.message}
        </text>
        {props.onRetry === undefined ? null : (
          <text bg={theme.overlayBg} {...retry.handlers}>
            <Spans spans={retrySpans(retry.hovered)} />
          </text>
        )}
      </Panel>
    </box>
  )
}
