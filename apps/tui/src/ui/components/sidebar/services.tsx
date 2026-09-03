import React from 'react'

import type { ServiceSnapshot } from '@dltech/atlas-harness'

import { plural } from '../../../store/tools/reading'
import type { SidebarCrewFold } from '../../../store/subagent-row'
import { isServiceRunning, serviceNameLabel, serviceReadout } from '../../services-model'
import { glyph, theme } from '../../theme'
import type { Span } from '../spans'
import { Row, Section } from './row'

const markFor = (service: ServiceSnapshot) => {
  if (isServiceRunning(service)) return { text: glyph.active, fg: theme.ok }
  return { text: glyph.seen, fg: theme.rule }
}

const valueFor = (args: { service: ServiceSnapshot; now: number }): readonly Span[] => [
  { text: serviceReadout(args), fg: isServiceRunning(args.service) ? theme.hint : theme.meta },
]

function FoldedLine(props: { fold: SidebarCrewFold; cells: number }): React.ReactNode {
  return (
    <Row
      label={plural(props.fold.hidden, 'more')}
      labelFg={theme.rule}
      cells={props.cells}
      mark={{ text: glyph.seen, fg: theme.rule }}
      {...(props.fold.hiddenFailed ? { value: [{ text: 'one failed', fg: theme.warn }] } : {})}
    />
  )
}

export function ServicesSection(props: {
  services: readonly ServiceSnapshot[]
  now: number
  cells: number
  fold?: SidebarCrewFold | undefined
}): React.ReactNode {
  const hidden = props.fold?.hidden ?? 0
  if (props.services.length === 0 && hidden === 0) return null

  const running = props.services.filter(isServiceRunning).length

  return (
    <Section label="Services" count={`${running}/${props.services.length + hidden}`}>
      {props.services.map((service) => (
        <box key={service.serviceId} flexShrink={0}>
          <Row
            label={serviceNameLabel(service)}
            labelFg={isServiceRunning(service) ? theme.hover : theme.meta}
            cells={props.cells}
            mark={markFor(service)}
            value={valueFor({ service, now: props.now })}
          />
        </box>
      ))}
      {props.fold === undefined || props.fold.hidden === 0 ? null : (
        <FoldedLine fold={props.fold} cells={props.cells} />
      )}
    </Section>
  )
}
