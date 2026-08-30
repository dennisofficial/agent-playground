import React, { type ReactNode } from 'react'

import { useWordSelect } from './use-word-select'

export function SelectionSurface(props: { children: ReactNode }): React.ReactNode {
  const handleMouse = useWordSelect()

  return (
    <box
      flexDirection="row"
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
      onMouse={handleMouse}
    >
      {props.children}
    </box>
  )
}
