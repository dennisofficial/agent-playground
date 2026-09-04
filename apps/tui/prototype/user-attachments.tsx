// PROTOTYPE — throwaway. How should a user message's attachments (skills, files, images) look in
// the transcript? Today they hang below the message slab on the app ground behind `⎿`, which reads
// as leftover glue rather than part of the message.
//
// Assumption: this is about the sent message in the transcript (the screenshot), not the live
// composer — "inside the composer" is read as "inside the message's own border".
//
// Five variants, switchable with ⇥ or ←/→:
//
//   baseline  The real UserBlock, untouched — the control every variant is judged against.
//   band      Attachments move inside the border: a seam drops to a darker ground and the rows
//             connect as a tree — `├` carries each row, `╰` closes the last.
//   chips     Attachments stay on the message ground but become filled pills, one per item, so a
//             skill, a file and an image all read as the same kind of thing. Chips carry the
//             dark ground (#2b2724) the band variants use.
//   bandchips The same pills, but set into the seamed dark band instead of onto the message
//             ground — band's container, chips' items.
//   icons     The bandchips layout stamped once per icon set, to settle the per-type glyphs.
//   hairline  Attachments stay on the message ground behind a rule row, each kind marked by its
//             own leading icon instead of one continuation glyph.
//   glyphs    The band layout stamped once per candidate glyph, to settle the `⎿` question.
//
//   bun run proto:attachments    (from this worktree root)
//
// It must own a real terminal: `bun run --filter` and `turbo run` both pipe a script's output,
// which leaves stdin un-raw and sizes the renderer to a default rather than the window.

import { base64Bytes, visualTokens, type SaidImage } from '@dltech/atlas-core'
import { createCliRenderer } from '@opentui/core'
import { createRoot, useKeyboard, useTerminalDimensions } from '@opentui/react'
import React, { type ReactNode, useState } from 'react'

import {
  BLANK_BORDER,
  PANEL_BOTTOM_EDGE,
  PANEL_TOP_EDGE,
  RAIL,
  RAIL_HEAD,
  RAIL_TAIL,
} from '../src/ui/borders'
import { UserBlock } from '../src/ui/components/blocks/user-block'
import { PANEL_INSET, PANEL_PAD } from '../src/ui/components/panel'
import { registerGrammars } from '../src/ui/markdown/grammars/index'
import { MarkdownView } from '../src/ui/markdown/markdown-view'
import { formatTokens, theme, TRANSCRIPT_INSET } from '../src/ui/theme'

const PAGES = ['baseline', 'band', 'chips', 'bandchips', 'icons', 'hairline', 'glyphs'] as const

type Page = (typeof PAGES)[number]

const BAND_BG = '#2b2724'

const RAIL_CHARS = { ...BLANK_BORDER, vertical: RAIL }
const HEAD_CHARS = { ...BLANK_BORDER, vertical: RAIL_HEAD }
const TAIL_CHARS = { ...BLANK_BORDER, vertical: RAIL_TAIL }
const TOP_EDGE_CHARS = { ...BLANK_BORDER, horizontal: PANEL_TOP_EDGE }
const BOTTOM_EDGE_CHARS = { ...BLANK_BORDER, horizontal: PANEL_BOTTOM_EDGE }

const RAILED = {
  border: ['left' as const],
  borderColor: theme.court.yours,
  customBorderChars: RAIL_CHARS,
}

const RESERVED = PANEL_INSET + PANEL_PAD + TRANSCRIPT_INSET

type Fixture = {
  label: string
  said: readonly string[]
  skills: readonly string[]
  files: readonly string[]
  images: readonly SaidImage[]
}

const IMAGE: SaidImage = {
  path: '/tmp/atlas-attach-shot.png',
  mediaType: 'image/png',
  data: 'QUJD'.repeat(500),
  width: 1208,
  height: 272,
}

const FIXTURES: readonly Fixture[] = [
  {
    label: 'the screenshot — slash commands and an @file, skills + file attached',
    said: ['Lets read and /implement using /tdd\n@/tmp/comp-v3-setup-session-to-nestjs-handoff.md'],
    skills: ['implement', 'tdd'],
    files: ['/tmp/comp-v3-setup-session-to-nestjs-handoff.md'],
    images: [],
  },
  {
    label: 'everything at once — skills, two files, an image',
    said: ['why does this fail?'],
    skills: ['tdd'],
    files: ['apps/tui/src/ui/components/blocks/user-block.tsx', 'apps/tui/src/ui/palette.ts'],
    images: [IMAGE],
  },
  {
    label: 'no attachments — every variant must agree on this one',
    said: ['plain message, nothing riding along'],
    skills: [],
    files: [],
    images: [],
  },
]

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

function imageText(image: SaidImage): string {
  const parts = [basename(image.path)]
  if (image.width !== undefined && image.height !== undefined) {
    parts.push(`${image.width}×${image.height}`)
  }
  const tokens = visualTokens({ byteLength: base64Bytes(image.data), ...image })
  if (tokens !== null) parts.push(`~${formatTokens(tokens)} tokens`)
  return parts.join(' · ')
}

type Mark = string | { first?: string; mid: string; last: string }

type AttachmentRow = { mark: string; text: string }

function attachmentTexts(fixture: Fixture): readonly string[] {
  const texts: string[] = []
  if (fixture.skills.length > 0) {
    const noun = fixture.skills.length === 1 ? 'skill' : 'skills'
    texts.push(`${noun} ${fixture.skills.join(', ')}`)
  }
  if (fixture.files.length > 0) {
    const noun = fixture.files.length === 1 ? 'file' : 'files'
    texts.push(`${noun} ${fixture.files.join(', ')}`)
  }
  for (const image of fixture.images) {
    texts.push(`image ${imageText(image)}`)
  }
  return texts
}

function attachmentRows(fixture: Fixture, mark: Mark): readonly AttachmentRow[] {
  const texts = attachmentTexts(fixture)
  return texts.map((text, index) => {
    if (typeof mark === 'string') return { mark, text }
    if (texts.length === 1) return { mark: mark.last, text }
    if (index === 0) return { mark: mark.first ?? mark.mid, text }
    return { mark: index === texts.length - 1 ? mark.last : mark.mid, text }
  })
}

function Said(props: { said: readonly string[]; width: number }): ReactNode {
  const columns = Math.max(20, props.width - RESERVED)
  return (
    <>
      {props.said.map((text, index) => (
        <MarkdownView
          key={`${index}:${text}`}
          source={text}
          width={columns}
          fg={theme.userFg}
          bg={theme.userBg}
        />
      ))}
    </>
  )
}

/**
 * The message slab built by hand from Panel's own pieces, so a variant can decide what happens
 * between the body and the closing half-row — Panel itself always closes straight after the body.
 */
function Slab(props: { width: number; body: ReactNode; band?: ReactNode }): ReactNode {
  const panelWidth = props.width - TRANSCRIPT_INSET
  const closing = props.band === undefined ? theme.userBg : BAND_BG

  return (
    <box flexDirection="column" width={panelWidth} flexShrink={0} marginBottom={1}>
      <box
        height={1}
        flexShrink={0}
        border={['left']}
        borderColor={theme.court.yours}
        customBorderChars={HEAD_CHARS}
      >
        <box
          height={1}
          flexGrow={1}
          border={['top']}
          borderColor={theme.userBg}
          customBorderChars={TOP_EDGE_CHARS}
        />
      </box>
      <box flexShrink={0} {...RAILED}>
        <box
          flexDirection="column"
          flexGrow={1}
          flexShrink={0}
          backgroundColor={theme.userBg}
          paddingLeft={PANEL_PAD}
          paddingRight={PANEL_PAD}
        >
          {props.body}
        </box>
      </box>
      {props.band === undefined ? null : (
        <box height={1} flexShrink={0} {...RAILED}>
          <box
            height={1}
            flexGrow={1}
            backgroundColor={BAND_BG}
            border={['bottom']}
            borderColor={theme.userBg}
            customBorderChars={BOTTOM_EDGE_CHARS}
          />
        </box>
      )}
      {props.band === undefined ? null : (
        <box flexShrink={0} {...RAILED}>
          <box
            flexDirection="column"
            flexGrow={1}
            flexShrink={0}
            backgroundColor={BAND_BG}
            paddingLeft={PANEL_PAD}
            paddingRight={PANEL_PAD}
          >
            {props.band}
          </box>
        </box>
      )}
      <box
        height={1}
        flexShrink={0}
        border={['left']}
        borderColor={theme.court.yours}
        customBorderChars={TAIL_CHARS}
      >
        <box
          height={1}
          flexGrow={1}
          border={['bottom']}
          borderColor={closing}
          customBorderChars={BOTTOM_EDGE_CHARS}
        />
      </box>
    </box>
  )
}

const CONNECTED: Mark = { mid: '├', last: '╰' }

function BandRows(props: { rows: readonly AttachmentRow[] }): ReactNode {
  return (
    <>
      {props.rows.map((row) => (
        <box key={row.text} flexDirection="row" flexShrink={0}>
          <text fg={theme.hint}>{row.mark}</text>
          <text fg={theme.meta}>{` ${row.text}`}</text>
        </box>
      ))}
    </>
  )
}

function BandMessage(props: { fixture: Fixture; width: number; mark?: Mark }): ReactNode {
  const rows = attachmentRows(props.fixture, props.mark ?? CONNECTED)
  return (
    <Slab
      width={props.width}
      body={<Said said={props.fixture.said} width={props.width} />}
      {...(rows.length === 0 ? {} : { band: <BandRows rows={rows} /> })}
    />
  )
}

type ChipIcons = { skill: string; file: string; image: string }

const CHIP_ICONS: ChipIcons = { skill: '✦', file: ' ', image: '▣' }

function Chip(props: { icon: string; label: string; fill: string }): ReactNode {
  const text = props.icon === '' ? ` ${props.label} ` : ` ${props.icon} ${props.label} `
  return (
    <box backgroundColor={props.fill} flexShrink={0}>
      <text fg={theme.body}>{text}</text>
    </box>
  )
}

function chipList(fixture: Fixture, fill: string, icons: ChipIcons): ReactNode[] {
  return [
    ...fixture.skills.map((skill) => (
      <Chip key={`s:${skill}`} icon={icons.skill} label={skill} fill={fill} />
    )),
    ...fixture.files.map((file) => (
      <Chip key={`f:${file}`} icon={icons.file} label={basename(file)} fill={fill} />
    )),
    ...fixture.images.map((image) => (
      <Chip key={`i:${image.path}`} icon={icons.image} label={imageText(image)} fill={fill} />
    )),
  ]
}

function ChipRow(props: { chips: ReactNode[]; marginTop?: number }): ReactNode {
  return (
    <box
      flexDirection="row"
      flexWrap="wrap"
      gap={1}
      flexShrink={0}
      {...(props.marginTop === undefined ? {} : { marginTop: props.marginTop })}
    >
      {props.chips}
    </box>
  )
}

function ChipsMessage(props: { fixture: Fixture; width: number }): ReactNode {
  const chips = chipList(props.fixture, BAND_BG, CHIP_ICONS)

  return (
    <Slab
      width={props.width}
      body={
        <>
          <Said said={props.fixture.said} width={props.width} />
          {chips.length === 0 ? null : <ChipRow chips={chips} marginTop={1} />}
        </>
      }
    />
  )
}

function BandChipsMessage(props: { fixture: Fixture; width: number; icons?: ChipIcons }): ReactNode {
  const chips = chipList(props.fixture, theme.selectedBg, props.icons ?? CHIP_ICONS)

  return (
    <Slab
      width={props.width}
      body={<Said said={props.fixture.said} width={props.width} />}
      {...(chips.length === 0 ? {} : { band: <ChipRow chips={chips} /> })}
    />
  )
}

function HairlineMessage(props: { fixture: Fixture; width: number }): ReactNode {
  const columns = Math.max(20, props.width - RESERVED - PANEL_PAD)
  const rows: ReactNode[] = [
    ...props.fixture.skills.map((skill) => (
      <text key={`s:${skill}`} fg={theme.meta}>{`✦ skill ${skill}`}</text>
    )),
    ...props.fixture.files.map((file) => (
      <text key={`f:${file}`} fg={theme.meta}>{`  file ${file}`}</text>
    )),
    ...props.fixture.images.map((image) => (
      <text key={`i:${image.path}`} fg={theme.meta}>{`▣ image ${imageText(image)}`}</text>
    )),
  ]

  return (
    <Slab
      width={props.width}
      body={
        <>
          <Said said={props.fixture.said} width={props.width} />
          {rows.length === 0 ? null : (
            <box flexDirection="column" marginTop={1} flexShrink={0}>
              <text fg={theme.rule}>{'─'.repeat(columns)}</text>
              {rows}
            </box>
          )}
        </>
      }
    />
  )
}

const INNER_LINE_CHARS = { ...BLANK_BORDER, vertical: '│' }

function LineRows(props: { texts: readonly string[] }): ReactNode {
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      alignSelf="flex-start"
      border={['left']}
      borderColor={theme.hint}
      customBorderChars={INNER_LINE_CHARS}
      paddingLeft={1}
    >
      {props.texts.map((text) => (
        <text key={text} fg={theme.meta}>
          {text}
        </text>
      ))}
    </box>
  )
}

const ICON_SETS: readonly { name: string; icons: ChipIcons }[] = [
  { name: 'current — ✦ skill ·   file · ▣ image', icons: CHIP_ICONS },
  { name: 'heavy — ◆ skill · ▤ file · ▩ image', icons: { skill: '◆', file: '▤', image: '▩' } },
  { name: 'outline — ✧ skill · ⬚ file · ▢ image', icons: { skill: '✧', file: '⬚', image: '▢' } },
  { name: 'emoji — ✨ skill · 📄 file · 🖼 image', icons: { skill: '✨', file: '📄', image: '🖼' } },
  { name: 'nerd font — \u{f0d0} skill · \u{f15b} file · \u{f03e} image (tofu if your font lacks them)', icons: { skill: '\u{f0d0}', file: '\u{f15b}', image: '\u{f03e}' } },
  { name: 'none — words only', icons: { skill: '', file: '', image: '' } },
]

function IconsPage(props: { width: number }): ReactNode {
  const fixture = FIXTURES[1] as Fixture
  return (
    <box flexDirection="column" gap={1} paddingTop={1} flexShrink={0}>
      <box paddingLeft={2}>
        <text fg={theme.rule}>the bandchips layout, one icon set per stamp — which triple?</text>
      </box>
      {ICON_SETS.map((set) => (
        <box key={set.name} flexDirection="column" flexShrink={0}>
          <box paddingLeft={2}>
            <text fg={theme.hint}>{set.name}</text>
          </box>
          <BandChipsMessage fixture={fixture} width={props.width} icons={set.icons} />
        </box>
      ))}
    </box>
  )
}

const GLYPH_CANDIDATES: readonly { name: string; mark?: Mark; line?: boolean }[] = [
  { name: 'rounded bracket — ╭ opens, │ carries, ╰ closes', mark: { first: '╭', mid: '│', last: '╰' } },
  { name: 'drawn line — a real border connects the rows, no glyphs at all', line: true },
  { name: 'bar — one heavy stroke per row', mark: '┃' },
  { name: 'connected, light — ├ carries, ╰ closes', mark: { mid: '├', last: '╰' } },
  { name: 'connected, heavy — ┣ carries, ┗ closes', mark: { mid: '┣', last: '┗' } },
  { name: '▪ square bullet', mark: '▪' },
  { name: '› chevron', mark: '›' },
  { name: '⁃ hyphen bullet', mark: '⁃' },
]

function GlyphsPage(props: { width: number }): ReactNode {
  const fixture = FIXTURES[1] as Fixture
  return (
    <box flexDirection="column" gap={1} paddingTop={1} flexShrink={0}>
      <box paddingLeft={2}>
        <text fg={theme.rule}>one band footer per candidate — which mark should attachments carry?</text>
      </box>
      {GLYPH_CANDIDATES.map((candidate) => (
        <box key={candidate.name} flexDirection="column" flexShrink={0}>
          <box paddingLeft={2}>
            <text fg={theme.hint}>{candidate.name}</text>
          </box>
          <Slab
            width={props.width}
            body={<Said said={fixture.said} width={props.width} />}
            band={
              candidate.line === true ? (
                <LineRows texts={attachmentTexts(fixture)} />
              ) : (
                <BandRows rows={attachmentRows(fixture, candidate.mark ?? '·')} />
              )
            }
          />
        </box>
      ))}
    </box>
  )
}

function FixtureView(props: { page: Page; fixture: Fixture; width: number }): ReactNode {
  const { fixture, width } = props
  return (
    <box flexDirection="column" flexShrink={0}>
      <box paddingLeft={2}>
        <text fg={theme.rule}>{fixture.label}</text>
      </box>
      {props.page === 'baseline' ? (
        <UserBlock
          said={fixture.said}
          width={width}
          skills={fixture.skills}
          files={fixture.files}
          images={fixture.images}
        />
      ) : null}
      {props.page === 'band' ? <BandMessage fixture={fixture} width={width} /> : null}
      {props.page === 'chips' ? <ChipsMessage fixture={fixture} width={width} /> : null}
      {props.page === 'bandchips' ? <BandChipsMessage fixture={fixture} width={width} /> : null}
      {props.page === 'hairline' ? <HairlineMessage fixture={fixture} width={width} /> : null}
    </box>
  )
}

function Bar(props: { page: Page; width: number }): ReactNode {
  return (
    <box flexDirection="row" flexShrink={0} backgroundColor={theme.panelBg} paddingLeft={2}>
      <text fg={theme.accent}>⏺ </text>
      <text fg={theme.hover}>{props.page}</text>
      <box flexGrow={1} />
      <text fg={theme.hint}>{`⇥ / ←→ switch · ctrl+c quit · ${props.width} cols  `}</text>
    </box>
  )
}

function UserAttachments(): ReactNode {
  const { width } = useTerminalDimensions()
  const [index, setIndex] = useState(0)
  const page = PAGES[((index % PAGES.length) + PAGES.length) % PAGES.length] ?? PAGES[0]

  useKeyboard((key) => {
    if (key.eventType === 'release') return
    if (key.ctrl === true && key.name === 'c') process.exit(0)
    if (key.name === 'tab' || key.name === 'right') setIndex((current) => current + 1)
    if (key.name === 'left') setIndex((current) => current - 1)
  })

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
      <Bar page={page} width={width} />
      {page === 'glyphs' ? <GlyphsPage width={width} /> : null}
      {page === 'icons' ? <IconsPage width={width} /> : null}
      {page === 'glyphs' || page === 'icons' ? null : (
        <box flexDirection="column" gap={1} paddingTop={1} flexShrink={0}>
          {FIXTURES.map((fixture) => (
            <FixtureView key={fixture.label} page={page} fixture={fixture} width={width} />
          ))}
        </box>
      )}
    </box>
  )
}

const PIPED = 1

if (import.meta.main) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write(
      'This prototype needs a real terminal. Run `bun run proto:attachments` from the worktree ' +
        'root — not through `bun run --filter` or `turbo run`, which pipe the output.\n',
    )
    process.exit(PIPED)
  }

  await registerGrammars()

  const renderer = await createCliRenderer({ useMouse: true, exitOnCtrlC: false, targetFps: 120 })
  renderer.on('destroy', () => process.exit(0))

  createRoot(renderer).render(<UserAttachments />)
}
