import React from 'react'

import { wrapWords } from '../text-flow'
import { theme } from '../theme'
import { Spans } from './spans'
import { EWorkingVerb, WorkingLine } from './working-line'

export type Compacting = { startedAt: number; cancelling: boolean }

const PAD = 2

const EDGE = 1

const INSET = EDGE + PAD * 2

const NARROWEST = 24

const HEADING = 'COMPACTING'

/**
 * Compaction leaves every row where it is and rewrites only what the model is sent, so the one
 * thing worth saying while it runs is that the transcript above is not about to change.
 */
const EXPLANATION =
  'Replacing the earlier turns with a summary so the conversation fits the window again. Every row stays in the transcript — only what the model is sent is rewritten.'

function Row(props: { children: React.ReactNode }): React.ReactNode {
  return (
    <box height={1} flexShrink={0} paddingLeft={PAD} paddingRight={PAD}>
      {props.children}
    </box>
  )
}

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
    <box
      position="absolute"
      left={0}
      right={0}
      bottom={0}
      zIndex={30}
      flexDirection="column"
      flexShrink={0}
      backgroundColor={theme.overlayBg}
      border={['top']}
      borderColor={theme.rule}
      paddingTop={1}
      paddingBottom={1}
    >
      <Row>
        <text>
          <Spans spans={[{ text: HEADING, fg: theme.meta }]} />
        </text>
      </Row>
      <Row>
        <WorkingLine
          elapsedMs={Math.max(0, props.now - props.compacting.startedAt)}
          outputTokens={0}
          interrupting={props.compacting.cancelling}
          verb={EWorkingVerb.Compacting}
        />
      </Row>
      <box height={1} flexShrink={0} />
      {said.map((line) => (
        <Row key={line}>
          <text fg={theme.hint}>{line}</text>
        </Row>
      ))}
    </box>
  )
}
