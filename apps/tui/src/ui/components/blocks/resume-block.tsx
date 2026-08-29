import React from 'react'

import { useClickRegion } from '../../hooks/use-click-region'
import {
  EKeyGroup,
  EKeyLayer,
  spellChord,
  useKeyBindings,
  type KeyDeclaration,
} from '../../keys'
import { glyph, theme } from '../../theme'
import { Spans } from '../spans'
import type { Span } from '../spans'

const RESUME: KeyDeclaration = {
  chord: 'ctrl+r',
  hint: 'resume',
  describe: 'pick a stopped turn up where it left off',
}

const FRESH = '/resume fresh'

const SEPARATOR = ' · '

const spansFor = (args: { hovered: boolean; fresh: boolean }): readonly Span[] => [
  { text: `${glyph.retry} ${spellChord(RESUME.chord)}`, fg: theme.accent },
  { text: ` ${RESUME.hint}`, fg: args.hovered ? theme.hover : theme.hint },
  ...(args.fresh
    ? [
        { text: SEPARATOR, fg: theme.dim },
        { text: `${FRESH} to say it again`, fg: theme.dim },
      ]
    : []),
]

export function ResumeBlock(props: {
  onResume: () => void
  onResumeFresh?: () => void
}): React.ReactNode {
  const region = useClickRegion(props.onResume)

  useKeyBindings([
    { ...RESUME, layer: EKeyLayer.Block, group: EKeyGroup.Turn, run: props.onResume },
  ])

  return (
    <box flexDirection="row" marginBottom={1} flexShrink={0}>
      <text {...region.handlers}>
        <Spans
          spans={spansFor({ hovered: region.hovered, fresh: props.onResumeFresh !== undefined })}
        />
      </text>
    </box>
  )
}
