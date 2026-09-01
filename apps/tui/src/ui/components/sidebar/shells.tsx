import React from 'react'

import type { ShellSnapshot } from '@dltech/atlas-harness'

import type { SidebarCrewFold } from '../../../store/subagent-row'
import { plural } from '../../../store/tools/reading'
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

/**
 * What the panel let go of, kept as one line rather than a heading of its own. The reading names
 * `/shells` because a reclaimed shell is still whole — the row leaves the sidebar, nothing leaves
 * the registry or its scrollback.
 */
function RetiredLine(props: { fold: SidebarCrewFold; cells: number }): React.ReactNode {
  return (
    <Row
      label={`${plural(props.fold.hidden, 'more')} in /shells`}
      labelFg={theme.rule}
      cells={props.cells}
      mark={{ text: glyph.seen, fg: theme.rule }}
      {...(props.fold.hiddenFailed ? { value: [{ text: 'one failed', fg: theme.warn }] } : {})}
    />
  )
}

export function ShellsSection(props: {
  shells: readonly ShellSnapshot[]
  cells: number
  fold?: SidebarCrewFold | undefined
  onOpen?: (shellId: string) => void
}): React.ReactNode {
  const press = usePress()
  if (props.shells.length === 0) return null

  const running = props.shells.filter(isShellRunning).length
  const hidden = props.fold?.hidden ?? 0

  return (
    <Section label="Shells" count={`${running}/${props.shells.length + hidden}`}>
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
      {props.fold === undefined || props.fold.hidden === 0 ? null : (
        <RetiredLine fold={props.fold} cells={props.cells} />
      )}
    </Section>
  )
}
