import { homedir } from 'node:os'

import React from 'react'

import { HEADER_GUTTER, headerBarModel, headerLocation, type DiffStat } from '../header-bar'
import { useAppearance } from '../hooks/use-appearance'
import { theme } from '../theme'
import { Spans } from './spans'

function DerivedHeaderBar(props: {
  width: number
  projectDirectory: string
  repoRoot: string
  diff: DiffStat | null
}): React.ReactNode {
  useAppearance()
  const model = headerBarModel({
    location: headerLocation({
      projectDirectory: props.projectDirectory,
      repoRoot: props.repoRoot,
      home: homedir(),
    }),
    diff: props.diff,
    cells: Math.max(0, props.width - HEADER_GUTTER * 2),
  })

  return (
    <box
      flexDirection="row"
      flexShrink={0}
      paddingLeft={HEADER_GUTTER}
      paddingRight={HEADER_GUTTER}
      backgroundColor={theme.panelBg}
    >
      <text flexShrink={0}>
        <Spans spans={model.left} />
      </text>
      <box flexGrow={1} />
      {model.right.length === 0 ? null : (
        <text flexShrink={0}>
          <Spans spans={model.right} />
        </text>
      )}
    </box>
  )
}

export const HeaderBar = React.memo(DerivedHeaderBar)
