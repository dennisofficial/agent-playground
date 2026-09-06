import { TextAttributes } from '@opentui/core'
import React, { useMemo } from 'react'

import { BLANK_BORDER } from '../../borders'
import { SourceSpan } from '../../selection/source-span'
import { theme } from '../../theme'
import { FencedBlock } from '../fenced-block'
import { TableBlock } from '../table-block'
import { EProseBlock, type ListItem, type ProseBlock, type SourcedBlock } from './blocks'
import { proseBlocksFor } from './growing-blocks'
import { InlineRun } from './inline-view'
import {
  bulletFor,
  DEFINITION_MARKER,
  FOOTNOTE_RULE_CELLS,
  headingInk,
  inlineCodeSlab,
  itemForeground,
  markerInk,
  ordinalFor,
  QUOTE_RAIL,
  quoteRailInk,
  RULE_CHAR,
  TASK_CHECKED,
  TASK_UNCHECKED,
} from './prose-style'

const QUOTE_BORDER = { ...BLANK_BORDER, vertical: QUOTE_RAIL }

const QUOTE_TEXT_PAD = 2

const ORDINAL_COLUMN = 2

type Frame = {
  readonly width: number
  readonly ground: string
  readonly slab: string
  readonly streaming: boolean
}

export function ProseView(props: {
  source: string
  width: number
  streaming?: boolean
  fg?: string
  bg?: string
}): React.ReactNode {
  const streaming = props.streaming === true
  const blocks = useMemo(
    () => proseBlocksFor({ source: props.source, streaming }),
    [props.source, streaming],
  )
  const frame = useMemo<Frame>(
    () => ({
      width: props.width,
      ground: props.fg ?? theme.hover,
      slab: inlineCodeSlab(props.bg),
      streaming,
    }),
    [props.width, props.fg, props.bg, streaming],
  )

  return <BlockStream blocks={blocks} frame={frame} />
}

function BlockStream(props: {
  blocks: readonly SourcedBlock[]
  frame: Frame
  tight?: boolean
}): React.ReactNode {
  return (
    <box flexDirection="column" flexShrink={0}>
      {props.blocks.map((sourced, index) => (
        <SourcedBlockView
          key={index}
          sourced={sourced}
          frame={props.frame}
          marginBottom={props.tight === true || index === props.blocks.length - 1 ? 0 : 1}
        />
      ))}
    </box>
  )
}

const SourcedBlockView = React.memo(function SourcedBlockView(props: {
  sourced: SourcedBlock
  frame: Frame
  marginBottom: number
}): React.ReactNode {
  return (
    <SourceSpan source={props.sourced.raw} marginBottom={props.marginBottom}>
      <Block block={props.sourced.block} frame={props.frame} />
    </SourceSpan>
  )
})

const Block = React.memo(function Block(props: {
  block: ProseBlock
  frame: Frame
}): React.ReactNode {
  const { block, frame } = props

  if (block.kind === EProseBlock.Heading) return <Heading block={block} frame={frame} />
  if (block.kind === EProseBlock.Paragraph) {
    return (
      <text wrapMode="word" fg={frame.ground}>
        <InlineRun nodes={block.content} ground={frame.ground} slab={frame.slab} />
      </text>
    )
  }
  if (block.kind === EProseBlock.List) return <List block={block} frame={frame} depth={0} />
  if (block.kind === EProseBlock.Quote) return <Quote block={block} frame={frame} level={0} />
  if (block.kind === EProseBlock.Rule) {
    return <text fg={theme.rule}>{RULE_CHAR.repeat(Math.max(1, frame.width))}</text>
  }
  if (block.kind === EProseBlock.Definitions) return <Definitions block={block} frame={frame} />
  if (block.kind === EProseBlock.Footnotes) return <Footnotes block={block} frame={frame} />
  if (block.kind === EProseBlock.Code) {
    return <FencedBlock language={block.language} source={block.source} width={frame.width} />
  }
  return <TableBlock markdown={block.markdown} width={frame.width} streaming={frame.streaming} />
})

function Heading(props: {
  block: Extract<ProseBlock, { kind: EProseBlock.Heading }>
  frame: Frame
}): React.ReactNode {
  const ink = headingInk(props.block.level)
  const title = (
    <text fg={ink.fg} attributes={ink.attributes} wrapMode="word">
      <InlineRun nodes={props.block.content} ground={ink.fg} slab={props.frame.slab} />
    </text>
  )

  if (props.block.level > 1) return title

  return (
    <box flexDirection="column" flexShrink={0}>
      {title}
      <text fg={theme.rule}>{RULE_CHAR.repeat(Math.max(1, props.frame.width))}</text>
    </box>
  )
}

function List(props: {
  block: Extract<ProseBlock, { kind: EProseBlock.List }>
  frame: Frame
  depth: number
}): React.ReactNode {
  return (
    <box flexDirection="column" flexShrink={0}>
      {props.block.items.map((item, index) => (
        <Item
          key={index}
          item={item}
          frame={props.frame}
          depth={props.depth}
          ordered={props.block.ordered}
          position={props.block.start + index}
        />
      ))}
    </box>
  )
}

function Item(props: {
  item: ListItem
  frame: Frame
  depth: number
  ordered: boolean
  position: number
}): React.ReactNode {
  const marker = markerFor(props)
  const ground = props.item.checked === true ? theme.meta : itemForeground(props.depth)
  const inner = Math.max(1, props.frame.width - marker.text.length)

  return (
    <box flexDirection="row" flexShrink={0}>
      <text fg={marker.fg} flexShrink={0}>
        {marker.text}
      </text>
      <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
        <text
          wrapMode="word"
          fg={ground}
          attributes={props.item.checked === true ? TextAttributes.STRIKETHROUGH : 0}
        >
          <InlineRun nodes={props.item.content} ground={ground} slab={props.frame.slab} />
        </text>
        <Children item={props.item} frame={{ ...props.frame, width: inner }} depth={props.depth} />
      </box>
    </box>
  )
}

function Children(props: { item: ListItem; frame: Frame; depth: number }): React.ReactNode {
  return (
    <>
      {props.item.children.map((child, index) =>
        child.kind === EProseBlock.List ? (
          <List key={index} block={child} frame={props.frame} depth={props.depth + 1} />
        ) : (
          <Block key={index} block={child} frame={props.frame} />
        ),
      )}
    </>
  )
}

function markerFor(args: { item: ListItem; ordered: boolean; depth: number; position: number }): {
  text: string
  fg: string
} {
  if (args.item.checked !== null) {
    return args.item.checked
      ? { text: `${TASK_CHECKED} `, fg: theme.ok }
      : { text: `${TASK_UNCHECKED} `, fg: theme.hint }
  }
  if (!args.ordered) return { text: `${bulletFor(args.depth)} `, fg: markerInk(args) }

  const ordinal = ordinalFor({ index: args.position, depth: args.depth })
  return { text: `${ordinal.padStart(ORDINAL_COLUMN)} `, fg: markerInk(args) }
}

function Quote(props: {
  block: Extract<ProseBlock, { kind: EProseBlock.Quote }>
  frame: Frame
  level: number
}): React.ReactNode {
  const inner: Frame = { ...props.frame, ground: theme.meta }

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      border={['left']}
      borderColor={quoteRailInk(props.level)}
      customBorderChars={QUOTE_BORDER}
    >
      {props.block.children.map((child, index) =>
        child.kind === EProseBlock.Quote ? (
          <Quote key={index} block={child} frame={inner} level={props.level + 1} />
        ) : (
          <box key={index} flexDirection="column" flexShrink={0} paddingLeft={QUOTE_TEXT_PAD}>
            <Block
              block={child}
              frame={{
                ...inner,
                width: Math.max(1, inner.width - QUOTE_TEXT_PAD - 1),
              }}
            />
          </box>
        ),
      )}
    </box>
  )
}

function Definitions(props: {
  block: Extract<ProseBlock, { kind: EProseBlock.Definitions }>
  frame: Frame
}): React.ReactNode {
  return (
    <box flexDirection="column" flexShrink={0}>
      <text wrapMode="word" fg={theme.userFg} attributes={TextAttributes.BOLD}>
        <InlineRun nodes={props.block.term} ground={theme.userFg} slab={props.frame.slab} />
      </text>
      {props.block.definitions.map((definition, index) => (
        <box key={index} flexDirection="row" flexShrink={0}>
          <text fg={theme.hint} flexShrink={0}>{`${DEFINITION_MARKER} `}</text>
          <text wrapMode="word" fg={props.frame.ground} flexGrow={1} flexShrink={1} flexBasis={0}>
            <InlineRun nodes={definition} ground={props.frame.ground} slab={props.frame.slab} />
          </text>
        </box>
      ))}
    </box>
  )
}

function Footnotes(props: {
  block: Extract<ProseBlock, { kind: EProseBlock.Footnotes }>
  frame: Frame
}): React.ReactNode {
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={theme.rule}>
        {RULE_CHAR.repeat(Math.min(FOOTNOTE_RULE_CELLS, props.frame.width))}
      </text>
      {props.block.notes.map((note, index) => (
        <box key={index} flexDirection="row" flexShrink={0}>
          <text fg={theme.link} flexShrink={0}>{`${note.marker} `}</text>
          <text wrapMode="word" fg={theme.meta} flexGrow={1} flexShrink={1} flexBasis={0}>
            <InlineRun nodes={note.content} ground={theme.meta} slab={props.frame.slab} />
          </text>
        </box>
      ))}
    </box>
  )
}
