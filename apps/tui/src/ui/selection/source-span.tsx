import type { BoxRenderable } from '@opentui/core'
import React, { useEffect, useRef, type ReactNode } from 'react'

import { forgetSource, registerSource } from './source-spans'

export function SourceSpan(props: {
  source: string
  marginBottom?: number
  children: ReactNode
}): React.ReactNode {
  const holder = useRef<BoxRenderable | null>(null)

  useEffect(() => {
    const renderable = holder.current
    if (renderable === null) return

    registerSource({ renderable, source: props.source })
    return () => forgetSource(renderable)
  }, [props.source])

  return (
    <box
      ref={holder}
      flexDirection="column"
      flexShrink={0}
      {...(props.marginBottom === undefined ? {} : { marginBottom: props.marginBottom })}
    >
      {props.children}
    </box>
  )
}
