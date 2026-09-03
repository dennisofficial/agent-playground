import React, { useMemo } from 'react'

import { SourceSpan } from '../selection/source-span'
import { theme } from '../theme'
import { FencedBlock, fenceWidth } from './fenced-block'
import { ProseView } from './prose/prose-view'
import { registerFallbackRenderer, registerFencedRenderer } from './registry'
import { codeRenderer, plainRenderer } from './renderers/code'
import { diffRenderer } from './renderers/diff'
import { lexicalRenderer } from './renderers/lexical'
import {
  growingSegments,
  type MarkdownSegment,
  segmentMarkdown,
  steadySegments,
} from './segment'
import { TableBlock } from './table-block'

// Registration order is precedence. `lexicalRenderer` precedes `codeRenderer` because the code
// renderable claims every non-empty language; a test holds the two language sets disjoint.
registerFencedRenderer(diffRenderer)
registerFencedRenderer(lexicalRenderer)
registerFencedRenderer(codeRenderer)
registerFallbackRenderer(plainRenderer)

type Colours = { fg?: string; bg?: string }

type FenceSegment = Extract<MarkdownSegment, { kind: 'fence' }>

const fenceMeasures = new WeakMap<FenceSegment, { forWidth: number; measured: number }>()

function levelledWidth(args: {
  segments: readonly MarkdownSegment[]
  width: number
}): number {
  let levelled = 0
  for (const segment of args.segments) {
    if (segment.kind !== 'fence') continue
    levelled = Math.max(levelled, measuredFence({ segment, width: args.width }))
  }
  return levelled
}

function measuredFence(args: { segment: FenceSegment; width: number }): number {
  const hit = fenceMeasures.get(args.segment)
  if (hit !== undefined && hit.forWidth === args.width) return hit.measured

  const measured = fenceWidth({
    language: args.segment.language,
    filename: args.segment.filename,
    source: args.segment.source,
    width: args.width,
  })
  fenceMeasures.set(args.segment, { forWidth: args.width, measured })
  return measured
}

const isBlank = (segment: MarkdownSegment): boolean =>
  segment.kind === 'prose' && segment.text.trim().length === 0

/**
 * A table opens on its own top edge, so whatever precedes it spends no row on the gap. The blank
 * line between two blocks lexes to a prose segment of pure whitespace, which draws nothing — so the
 * question is what the next segment that DRAWS is, not what the next segment is.
 */
function hugsNext(args: { segments: readonly MarkdownSegment[]; index: number }): boolean {
  const next = args.segments.slice(args.index + 1).find((segment) => !isBlank(segment))
  return next === undefined || next.kind === 'table'
}

export function MarkdownView(props: {
  source: string
  width: number
  streaming?: boolean
  fg?: string
  bg?: string
}): React.ReactNode {
  const streaming = props.streaming === true
  const segments = useMemo(() => {
    if (!streaming) return segmentMarkdown(props.source)
    return steadySegments({ segments: growingSegments({ source: props.source }) })
  }, [props.source, streaming])

  /**
   * One width for every fence in the answer. Sized to the widest of them rather than to the room
   * available, so a message of short snippets stays a column of slabs instead of a wall of fill —
   * but a message of several never draws a ragged right edge.
   */
  const levelled = levelledWidth({ segments, width: props.width })

  return (
    <box flexDirection="column">
      {segments.map((segment, index) => (
        <Segment
          key={index}
          segment={segment}
          width={props.width}
          levelled={levelled}
          live={streaming && index === segments.length - 1}
          hugsNext={hugsNext({ segments, index })}
          {...(props.fg === undefined ? {} : { fg: props.fg })}
          {...(props.bg === undefined ? {} : { bg: props.bg })}
        />
      ))}
    </box>
  )
}

function Segment(
  props: Colours & {
    segment: MarkdownSegment
    width: number
    live: boolean
    hugsNext: boolean
    levelled: number
  },
): React.ReactNode {
  const { segment } = props

  if (segment.kind === 'table') {
    return (
      <SourceSpan source={segment.markdown}>
      <TableBlock
        markdown={segment.markdown}
        width={props.width}
        streaming={props.live}
        fg={props.fg ?? theme.hover}
        {...(props.bg === undefined ? {} : { bg: props.bg })}
      />
      </SourceSpan>
    )
  }

  if (segment.kind === 'fence') {
    return (
      <SourceSpan source={segment.raw}>
        <FencedBlock
          language={segment.language}
          filename={segment.filename}
          source={segment.source}
          width={props.width}
          streaming={props.live}
          attached={props.hugsNext}
          levelled={props.levelled}
        />
      </SourceSpan>
    )
  }

  if (isBlank(segment)) return null

  return (
    <box flexDirection="column" flexShrink={0} marginBottom={props.hugsNext ? 0 : 1}>
      <ProseView
        source={segment.text}
        width={props.width}
        streaming={props.live}
        {...(props.fg === undefined ? {} : { fg: props.fg })}
        {...(props.bg === undefined ? {} : { bg: props.bg })}
      />
    </box>
  )
}
