import React from 'react'

import { useClickRegion } from '../../hooks/use-click-region'
import {
  sectionsAt,
  spansOf,
  type ESidebarPlace,
  type SidebarSection,
  type SidebarSectionRow,
} from '../../sidebar-section'
import { theme } from '../../theme'
import { Row, Section } from './row'

function ContributedRow(props: { row: SidebarSectionRow; cells: number }): React.ReactNode {
  const region = useClickRegion(props.row.onActivate)

  return (
    <box
      flexShrink={0}
      {...region.handlers}
      {...(region.wash.bg === undefined ? {} : { backgroundColor: region.wash.bg })}
    >
      <Row label="" labelFg={theme.meta} cells={props.cells} value={spansOf({ row: props.row, cells: props.cells })} />
    </box>
  )
}

function ContributedSection(props: { section: SidebarSection; cells: number }): React.ReactNode {
  const rows = props.section.rows.map((row) => (
    <ContributedRow key={row.id} row={row} cells={props.cells} />
  ))

  if (props.section.label === undefined) {
    return (
      <box flexDirection="column" flexShrink={0}>
        {rows}
      </box>
    )
  }

  return <Section label={props.section.label}>{rows}</Section>
}

export function ContributedSections(props: {
  sections: readonly SidebarSection[]
  place: ESidebarPlace
  cells: number
}): React.ReactNode {
  const showing = sectionsAt({ sections: props.sections, place: props.place })
  if (showing.length === 0) return null

  return (
    <>
      {showing.map((section) => (
        <ContributedSection key={section.id} section={section} cells={props.cells} />
      ))}
    </>
  )
}
