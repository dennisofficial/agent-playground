// PROTOTYPE — throwaway. The three sidebar treatments the shell directions differ by.

import React from 'react'

import { BLANK_BORDER } from '../src/ui/borders'
import { formatElapsed, formatTokens, glyph, theme, SIDEBAR_WIDTH } from '../src/ui/theme'
import { THREAD_LABEL, MODEL, WHERE } from './session'

/** A column divider, deliberately lighter than the ┃ that marks what the operator wrote. */
const DIVIDER = '│'

const SEAM_CHARS = { ...BLANK_BORDER, vertical: DIVIDER }

const ELAPSED_MS = 41_000

const TOKENS = 4210

function SectionLabel(props: { label: string }): React.ReactNode {
  return <text fg={theme.meta}>{props.label.toUpperCase()}</text>
}

function TurnLines(props: { working: boolean }): React.ReactNode {
  return (
    <>
      <text fg={props.working ? theme.ok : theme.hint}>
        {props.working ? `working · ${formatElapsed(ELAPSED_MS)}` : 'idle'}
      </text>
      <text fg={theme.hint}>{`↓ ${formatTokens(TOKENS)} tokens`}</text>
    </>
  )
}

function Wordmark(): React.ReactNode {
  return (
    <text>
      <span fg={theme.accent}>{glyph.block} </span>
      <span fg={theme.hover}>atlas</span>
    </text>
  )
}

function Section(props: { label?: string; children: React.ReactNode }): React.ReactNode {
  return (
    <box flexDirection="column">
      {props.label === undefined ? null : <SectionLabel label={props.label} />}
      {props.children}
    </box>
  )
}

function Column(props: { seamed?: boolean; children: React.ReactNode }): React.ReactNode {
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      width={SIDEBAR_WIDTH}
      paddingTop={1}
      paddingBottom={1}
      paddingRight={2}
      gap={1}
      {...(props.seamed
        ? {
            border: ['left' as const],
            borderColor: theme.rule,
            customBorderChars: SEAM_CHARS,
            paddingLeft: 2,
          }
        : { backgroundColor: theme.panelBg, paddingLeft: 2 })}
    >
      {props.children}
    </box>
  )
}

/** A filled column, sections held apart by spacing alone. */
export function QuietSidebar(props: { working: boolean }): React.ReactNode {
  return (
    <Column>
      <Section label="Session">
        <text fg={theme.hover}>{MODEL}</text>
        <text fg={theme.hint}>{THREAD_LABEL}</text>
      </Section>
      <Section label="Turn">
        <TurnLines working={props.working} />
      </Section>
      <box flexGrow={1} />
      <Section>
        <text fg={theme.hint}>{WHERE}</text>
        <Wordmark />
      </Section>
    </Column>
  )
}

/** Identity lives in the top strip, so this column holds only what is live. */
export function StripSidebar(props: { working: boolean }): React.ReactNode {
  return (
    <Column>
      <Section label="Turn">
        <TurnLines working={props.working} />
      </Section>
      <Section label="Tools">
        <text fg={theme.hint}>nothing pending</text>
      </Section>
    </Column>
  )
}

/** No fill anywhere — a │ divider separates the columns and sections stand on spacing alone. */
export function RailedSidebar(props: { working: boolean }): React.ReactNode {
  return (
    <Column seamed>
      <Section label="Session">
        <text fg={theme.hover}>{MODEL}</text>
        <text fg={theme.hint}>{THREAD_LABEL}</text>
      </Section>
      <Section label="Turn">
        <TurnLines working={props.working} />
      </Section>
      <box flexGrow={1} />
      <Section>
        <text fg={theme.hint}>{WHERE}</text>
        <Wordmark />
      </Section>
    </Column>
  )
}
