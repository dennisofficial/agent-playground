import React from 'react'

import type { ShellSnapshot } from '@dltech/atlas-harness'

import { usePress } from '../../hooks/use-press'
import {
  AWAITING_INPUT_LABEL,
  isShellRunning,
  shellNameLabel,
  shellStateLabel,
} from '../../shells-model'
import { glyph, theme } from '../../theme'
import { Row, Section } from './row'

const markFor = (shell: ShellSnapshot) => {
  if (shell.awaitingInput) return { text: glyph.warning, fg: theme.warn }
  if (isShellRunning(shell)) return { text: glyph.active, fg: theme.ok }
  return { text: glyph.seen, fg: theme.rule }
}

const valueFor = (shell: ShellSnapshot) => {
  const label = shellStateLabel(shell)
  if (shell.awaitingInput) return [{ text: AWAITING_INPUT_LABEL, fg: theme.warn }]
  if (isShellRunning(shell)) return [{ text: label, fg: theme.hint }]
  return [{ text: label, fg: theme.meta }]
}

export function ShellsSection(props: {
  shells: readonly ShellSnapshot[]
  cells: number
  onOpen?: (shellId: string) => void
}): React.ReactNode {
  const press = usePress()
  if (props.shells.length === 0) return null

  const running = props.shells.filter(isShellRunning).length

  return (
    <Section label="Shells" count={`${running}/${props.shells.length}`}>
      {props.shells.map((shell) => (
        <box
          key={shell.shellId}
          flexShrink={0}
          {...press(props.onOpen === undefined ? undefined : () => props.onOpen?.(shell.shellId))}
        >
          <Row
            label={shellNameLabel(shell)}
            labelFg={isShellRunning(shell) ? theme.hover : theme.meta}
            cells={props.cells}
            mark={markFor(shell)}
            value={valueFor(shell)}
          />
        </box>
      ))}
    </Section>
  )
}
