import { useRenderer, useTerminalDimensions } from '@opentui/react'
import React from 'react'

import type { ToolCall } from '../../../store'
import { imageOf, imageSummary } from '../../../store/tools'
import { useTranscriptCovered } from '../../covered-store'
import { imageRows } from '../../image-rows-store'
import { DEFAULT_CELL_ASPECT, SAMPLES_PER_CELL, imageCellSpan } from '../../images'
import '../../images/transcript-image'
import { tailOfPath } from '../../paths'
import { theme } from '../../theme'
import { useTranscriptRows } from '../../viewport-rows-store'

const INDENT = '    '

const VIEWPORT_SHARE = 0.8

/**
 * A picture is kept strictly shorter than the transcript, so there is always a scroll position that
 * shows all of it. One that exactly fills the viewport is clipped at every position instead.
 */
const HEADROOM = 2

export function ToolImage(props: { call: ToolCall; inner: number; cwd: string }): React.ReactNode {
  const renderer = useRenderer()
  const { height } = useTerminalDimensions()
  const rows = useTranscriptRows()
  const covered = useTranscriptCovered()
  const image = imageOf(props.call)
  const summary = imageSummary({ call: props.call, cwd: props.cwd })

  if (summary === null || image === null) return null

  const cells = Math.max(8, props.inner - INDENT.length)
  const cell = cellMetricsOf(renderer)
  const span =
    covered || image.width === null || image.height === null
      ? null
      : imageCellSpan({
          source: { width: image.width, height: image.height },
          availableColumns: cells,
          maxRows: tallestOf({ rows, terminalHeight: height }),
          cellAspect: cell.aspect,
          cellWidth: cell.width,
        })

  return (
    <box flexDirection="column" flexShrink={0}>
      <text wrapMode="none" width={props.inner} flexShrink={0}>
        <span fg={theme.meta}>{`${INDENT}${tailOfPath({ path: summary, cells })}`}</span>
      </text>
      {span === null || span.columns < 1 || span.rows < 1 ? null : (
        <box paddingLeft={INDENT.length} flexShrink={0}>
          <transcript-image
            source={image.path}
            protocol="auto"
            fit="fit"
            style={{ width: span.columns, height: span.rows }}
          />
        </box>
      )}
    </box>
  )
}

type CellMetrics = { aspect: number; width: number }

const BLOCK_SAMPLER: CellMetrics = { aspect: DEFAULT_CELL_ASPECT, width: SAMPLES_PER_CELL }

/**
 * Matches `ImageRenderable.cellAspectRatio`, so the box we reserve is the box it draws into. With no
 * resolution to report, OpenTUI paints blocks rather than pixels, and there a cell really is two
 * samples wide.
 */
function cellMetricsOf(renderer: ReturnType<typeof useRenderer>): CellMetrics {
  const resolution = renderer.resolution
  if (!resolution || renderer.terminalWidth < 1 || renderer.terminalHeight < 1) return BLOCK_SAMPLER

  const width = resolution.width / renderer.terminalWidth
  const height = resolution.height / renderer.terminalHeight
  if (width <= 0 || height <= 0) return BLOCK_SAMPLER

  return { aspect: height / width, width }
}

function tallestOf(args: { rows: number; terminalHeight: number }): number {
  const room =
    args.rows > 0
      ? args.rows - HEADROOM
      : Math.floor(args.terminalHeight * VIEWPORT_SHARE) - HEADROOM

  return Math.max(4, Math.min(imageRows(), room))
}
