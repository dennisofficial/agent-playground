import { TextAttributes } from '@opentui/core'
import React from 'react'

import { glyph, theme } from '../../theme'
import { EInline, type InlineNode } from './inline'
import { codeForeground, LINK_ARROW, markAttributes, markForeground } from './prose-style'

export function InlineRun(props: {
  nodes: readonly InlineNode[]
  ground: string
  slab: string
}): React.ReactNode {
  return (
    <>
      {props.nodes.map((node, index) => (
        <InlineSpan key={index} node={node} ground={props.ground} slab={props.slab} />
      ))}
    </>
  )
}

function InlineSpan(props: { node: InlineNode; ground: string; slab: string }): React.ReactNode {
  const { node } = props

  if (node.kind === EInline.Text) {
    return (
      <span
        fg={markForeground({ marks: node.marks, ground: props.ground })}
        attributes={markAttributes(node.marks)}
      >
        {node.text}
      </span>
    )
  }

  if (node.kind === EInline.Code) {
    return (
      <span fg={codeForeground(node.marks)} bg={props.slab} attributes={markAttributes(node.marks)}>
        {node.text}
      </span>
    )
  }

  if (node.kind === EInline.Link) {
    return (
      <>
        <span fg={theme.link} attributes={TextAttributes.UNDERLINE} link={{ url: node.href }}>
          {plain(node.label)}
        </span>
        <span fg={theme.hint}>{` ${node.host} ${LINK_ARROW}`}</span>
      </>
    )
  }

  if (node.kind === EInline.Image) {
    return (
      <>
        <span fg={theme.court.external}>{`${glyph.image} `}</span>
        <span fg={props.ground}>{node.alt}</span>
        <span fg={theme.hint}>{` · ${node.path}`}</span>
      </>
    )
  }

  return <span fg={theme.link}>{node.marker}</span>
}

function plain(nodes: readonly InlineNode[]): string {
  return nodes
    .map((node) =>
      node.kind === EInline.Text || node.kind === EInline.Code
        ? node.text
        : node.kind === EInline.Link
          ? plain(node.label)
          : node.kind === EInline.Image
            ? node.alt
            : node.marker,
    )
    .join('')
}
