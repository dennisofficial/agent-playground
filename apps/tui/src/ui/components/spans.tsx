import React from 'react'

export type Span = { text: string; fg?: string }

export function Spans(props: { spans: readonly Span[] }): React.ReactNode {
  return (
    <>
      {props.spans.map((span, index) => (
        <span key={index} {...(span.fg === undefined ? {} : { fg: span.fg })}>
          {span.text}
        </span>
      ))}
    </>
  )
}
