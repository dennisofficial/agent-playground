import React from 'react'

import { ESandboxState } from '@dltech/atlas-harness'

import type { SidebarContainer } from '../../../store/sidebar-model'
import { glyph, theme } from '../../theme'
import type { Span } from '../spans'
import { truncateCells } from './cells'
import { Row, Section } from './row'

const markFor = (state: ESandboxState): Span => {
  switch (state) {
    case ESandboxState.Running:
      return { text: glyph.active, fg: theme.ok }
    case ESandboxState.Starting:
      return { text: glyph.active, fg: theme.warn }
    case ESandboxState.Failed:
      return { text: glyph.failed, fg: theme.warn }
    case ESandboxState.Stopped:
      return { text: glyph.available, fg: theme.rule }
  }
}

const portsLabel = (ports: SidebarContainer['ports']): string =>
  ports.map((one) => `${one.containerPort}→${one.hostPort}`).join('  ')

const limitsLabel = (limits: NonNullable<SidebarContainer['limits']>): string =>
  `${limits.cpus} cpu · ${limits.memoryGb} GB`

export function ContainerSection(props: {
  container: SidebarContainer
  cells: number
}): React.ReactNode {
  const { container, cells } = props

  return (
    <Section label="Container">
      <Row
        label={container.state}
        labelFg={theme.hover}
        cells={cells}
        mark={markFor(container.state)}
        value={[{ text: container.label, fg: theme.hint }]}
      />
      {container.limits === undefined ? null : (
        <Row
          label="limits"
          labelFg={theme.meta}
          cells={cells}
          value={[{ text: limitsLabel(container.limits), fg: theme.hint }]}
        />
      )}
      {container.ports.length === 0 ? null : (
        <Row
          label="ports"
          labelFg={theme.meta}
          cells={cells}
          value={[{ text: portsLabel(container.ports), fg: theme.hint }]}
        />
      )}
      {container.state !== ESandboxState.Failed || container.reason === undefined ? null : (
        <text fg={theme.warn}>{truncateCells({ text: container.reason, cells })}</text>
      )}
    </Section>
  )
}
