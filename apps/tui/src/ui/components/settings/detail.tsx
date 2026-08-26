import { homedir } from 'node:os'

import type { ResolvedSetting } from '@dltech/atlas-core'
import React from 'react'

import { collapseHome, tailOfPath } from '../../paths'
import { provenanceOf } from '../../settings-format'
import { glyph, theme } from '../../theme'
import { wrapWords } from '../../text-flow'
import { Spans } from '../spans'

const DETAIL_PAD = 2

const SET_BY = 'Set by'

const detailCells = (width: number): number => Math.max(0, width - DETAIL_PAD * 2)

function Heading(props: { label: string }): React.ReactNode {
  return <text fg={theme.meta}>{props.label.toUpperCase()}</text>
}

export function SettingsDetail(props: {
  width: number
  setting: ResolvedSetting | undefined
  cwd: string
}): React.ReactNode {
  const cells = detailCells(props.width)
  const where = collapseHome({ cwd: props.cwd, home: homedir() })

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      width={props.width}
      backgroundColor={theme.panelBg}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={DETAIL_PAD}
      paddingRight={DETAIL_PAD}
    >
      {props.setting === undefined ? null : (
        <box flexDirection="column" flexShrink={0} gap={1}>
          <box flexDirection="column" flexShrink={0}>
            <Heading label={props.setting.definition.label} />
            {wrapWords({ text: props.setting.definition.description, width: cells }).map((line) => (
              <text key={line} fg={theme.meta}>
                {line}
              </text>
            ))}
          </box>
          <box flexDirection="column" flexShrink={0}>
            <Heading label={SET_BY} />
            <text fg={theme.hint}>{provenanceOf(props.setting)}</text>
          </box>
        </box>
      )}
      <box flexGrow={1} flexShrink={1} flexBasis={0} />
      <box flexDirection="column" flexShrink={0}>
        <text fg={theme.dim}>{tailOfPath({ path: where, cells })}</text>
        <text>
          <Spans
            spans={[
              { text: `${glyph.unseen} `, fg: theme.accent },
              { text: 'atlas', fg: theme.hover },
            ]}
          />
        </text>
      </box>
    </box>
  )
}
