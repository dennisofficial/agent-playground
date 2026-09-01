import React from 'react'

import { wrapWords } from '../text-flow'
import { theme } from '../theme'
import { BottomDrawer, DrawerLine, DRAWER_INSET } from './drawer'
import { Spans } from './spans'
import { EWorkingVerb, WorkingLine } from './working-line'

export type Compacting = { startedAt: number; cancelling: boolean }

const INSET = DRAWER_INSET

const NARROWEST = 24

const HEADING = 'COMPACTING'

/**
 * Compaction leaves every row where it is and rewrites only what the model is sent, so the one
 * thing worth saying while it runs is that the transcript above is not about to change.
 */
const EXPLANATION =
  'Replacing the earlier turns with a summary so the conversation fits the window again. Every row stays in the transcript — only what the model is sent is rewritten.'

/**
 * Compaction rises from the bottom over the composer rather than taking a row in the transcript:
 * a line that grew inside the history would move the rows it was describing while they were read.
 */
export function CompactingOverlay(props: {
  compacting: Compacting
  now: number
  width: number
}): React.ReactNode {
  const inner = Math.max(NARROWEST, props.width - INSET)
  const said = wrapWords({ text: EXPLANATION, width: inner })

  return (
    <BottomDrawer overlay>
      <DrawerLine>
        <text>
          <Spans spans={[{ text: HEADING, fg: theme.meta }]} />
        </text>
      </DrawerLine>
      <DrawerLine>
        <WorkingLine
          elapsedMs={Math.max(0, props.now - props.compacting.startedAt)}
          outputTokens={0}
          interrupting={props.compacting.cancelling}
          verb={EWorkingVerb.Compacting}
        />
      </DrawerLine>
      <box height={1} flexShrink={0} />
      {said.map((line) => (
        <DrawerLine key={line}>
          <text fg={theme.hint}>{line}</text>
        </DrawerLine>
      ))}
    </BottomDrawer>
  )
}
