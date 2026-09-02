import type { Grant } from '@dltech/atlas-core'
import React from 'react'

import { usePress } from '../../hooks/use-press'
import { glyph, theme } from '../../theme'
import { Row, Section } from './row'

export const GRANTS_HEADING = 'Grants'

export const REVOKE_NOTE = 'click one to take it back'

const INDENT = '  '

export function GrantsSection(props: {
  grants: readonly Grant[]
  cells: number
  onRevoke?: (grantId: string) => void
}): React.ReactNode {
  const press = usePress()
  if (props.grants.length === 0) return null

  const { onRevoke } = props

  return (
    <Section label={GRANTS_HEADING} count={String(props.grants.length)}>
      {props.grants.map((grant) => (
        <box
          key={grant.grantId}
          flexDirection="column"
          flexShrink={0}
          {...press(onRevoke === undefined ? undefined : () => onRevoke(grant.grantId))}
        >
          <Row
            label={grant.subject}
            labelFg={theme.hover}
            cells={props.cells}
            mark={{ text: glyph.passed, fg: theme.ok }}
          />
          <Row
            label={`${INDENT}${grant.dimensions.join(', ')}`}
            labelFg={theme.meta}
            cells={props.cells}
          />
        </box>
      ))}
      <Row label={REVOKE_NOTE} labelFg={theme.rule} cells={props.cells} />
    </Section>
  )
}
