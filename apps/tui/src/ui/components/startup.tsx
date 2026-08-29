import React from 'react'

import { PANEL_BOTTOM_EDGE } from '../borders'
import { mixHex } from '../colour'
import { collapseHome, tailOfPath } from '../paths'
import { type StartupFrame } from '../startup-model'
import { glyph, theme } from '../theme'
import { wordmarkRows, WORDMARK_CELLS, WORDMARK_ROWS } from '../wordmark'
import { Spans } from './spans'

const WORDMARK = 'atlas'

const SEPARATOR = ' · '

const SIDE_AIR = 4

const CURTAIN_Z = 900

const STATUS_AIR = 2

const STATUS_ROWS = STATUS_AIR + 1

const SEAM_FALL = 0.45

const fadedTo = (args: { colour: string; drain: number }): string =>
  mixHex({ from: args.colour, to: theme.appBg, amount: args.drain })

/**
 * The half cell the whole app is built from: `▀` in the curtain's own ground over the seam colour,
 * so what trails the retracting edge is half a row of accent rather than a whole one.
 */
function Seam(props: { width: number; lift: number }): React.ReactNode {
  return (
    <box position="absolute" left={0} right={0} bottom={0} height={1}>
      <text
        fg={theme.appBg}
        bg={fadedTo({ colour: theme.accent, drain: SEAM_FALL + props.lift * (1 - SEAM_FALL) })}
      >
        {PANEL_BOTTOM_EDGE.repeat(props.width)}
      </text>
    </box>
  )
}

function Mark(props: { frame: StartupFrame; roomy: boolean }): React.ReactNode {
  const { reveal, drain } = props.frame

  if (!props.roomy) {
    const gone = 1 - reveal * (1 - drain)

    return (
      <box height={1} flexShrink={0} flexDirection="row">
        <text fg={fadedTo({ colour: theme.accent, drain: gone })}>{`${glyph.block} `}</text>
        <text fg={fadedTo({ colour: theme.hover, drain: gone })}>{WORDMARK}</text>
      </box>
    )
  }

  const rows = wordmarkRows({
    accent: theme.accent,
    ground: theme.appBg,
    bright: theme.bright,
    sweep: { reveal, drain },
  })

  return (
    <box flexDirection="column" flexShrink={0} height={WORDMARK_ROWS} width={WORDMARK_CELLS}>
      {rows.map((row, index) => (
        <box key={index} height={1} flexShrink={0}>
          <text>
            <Spans spans={row} />
          </text>
        </box>
      ))}
    </box>
  )
}

/**
 * Drawn over a workspace that is already mounted and settled, so what the curtain hides is not an
 * empty screen but the first paint correcting itself.
 */
export function Startup(props: {
  frame: StartupFrame
  width: number
  height: number
  status: string
  cwd: string
  home: string
}): React.ReactNode {
  const rows = Math.max(0, Math.round(props.height * (1 - props.frame.lift)))
  if (rows === 0) return null

  const roomy =
    props.width >= WORDMARK_CELLS + SIDE_AIR &&
    props.height >= WORDMARK_ROWS + STATUS_ROWS + SIDE_AIR
  const drain = Math.min(1, props.frame.drain + props.frame.lift)
  const dim = fadedTo({ colour: theme.hint, drain })
  const rule = fadedTo({ colour: theme.rule, drain })

  const where = tailOfPath({
    path: collapseHome({ cwd: props.cwd, home: props.home }),
    cells: Math.max(
      0,
      props.width - SIDE_AIR - SEPARATOR.length - [...props.status].length,
    ),
  })

  return (
    <box
      position="absolute"
      left={0}
      right={0}
      top={0}
      height={rows}
      zIndex={CURTAIN_Z}
      overflow="hidden"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      backgroundColor={theme.appBg}
    >
      <Mark frame={props.frame} roomy={roomy} />
      <box height={STATUS_AIR} flexShrink={0} />
      <box height={1} flexShrink={0}>
        <text>
          <Spans
            spans={[
              { text: where, fg: dim },
              { text: SEPARATOR, fg: rule },
              { text: props.status, fg: dim },
            ]}
          />
        </text>
      </box>
      {props.frame.lift > 0 ? <Seam width={props.width} lift={props.frame.lift} /> : null}
    </box>
  )
}
