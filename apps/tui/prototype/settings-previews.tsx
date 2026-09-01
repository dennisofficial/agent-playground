// PROTOTYPE — throwaway. One scene per setting, not one scene for all of them.
//
// A preview earns its place by showing the thing the setting actually governs: the composer edge
// draws a composer, block padding draws the two slabs it pads (a fence and a diff), the accent
// draws the marks that carry it. Every scene is built from the real components and reads the real
// appearance globals, so a preview cannot drift from the app it claims to be showing.

import { parseUnifiedDiff, type DiffFile } from '@dltech/atlas-core'
import React from 'react'

import { accentHex } from '../src/ui/accents'
import type { Appearance } from '../src/ui/appearance'
import { Composer, EComposerTone } from '../src/ui/components/composer'
import { InlineDiff } from '../src/ui/components/diff/inline-diff'
import { useDraft } from '../src/ui/hooks/use-draft'
import { FencedBlock } from '../src/ui/markdown/fenced-block'
import { MarkdownView } from '../src/ui/markdown/markdown-view'

export type Preview = {
  render: (args: { width: number; appearance: Appearance }) => React.ReactNode
}

const PATCH = [
  'diff --git a/src/ui/theme.ts b/src/ui/theme.ts',
  '--- a/src/ui/theme.ts',
  '+++ b/src/ui/theme.ts',
  '@@ -11,8 +11,8 @@ export const theme: Palette = {',
  '   appBg:\'#282422\',',
  '-  accent: ACCENT,',
  '-  codeInline: ACCENT,',
  '+  accent: accentHex(chosen),',
  '+  codeInline: accentHex(chosen),',
  '   dim: \'#6b625c\',',
].join('\n')

const DIFF: DiffFile | undefined = parseUnifiedDiff(PATCH)[0]

const FENCE = ['const rail = theme.accent', 'const fill = theme.panelBg'].join('\n')

const PROSE = 'The accent carries `theme.accent` through every mark the app draws.'

function ComposerPreview(props: { width: number }): React.ReactNode {
  const draft = useDraft('the draft, edged the way you picked')

  return (
    <Composer
      draft={draft}
      width={props.width}
      tone={EComposerTone.Idle}
      placeholder="Ask anything"
      maxRows={2}
      focused={false}
      title="composer edge"
    />
  )
}

function Swatches(props: { chosen: string }): React.ReactNode {
  return (
    <box flexDirection="row" flexShrink={0} gap={2}>
      {['clay', 'slate', 'moss', 'plum'].map((name) => (
        <text key={name} fg={accentHex(name)}>
          {name === props.chosen ? `● ${name}` : `○ ${name}`}
        </text>
      ))}
    </box>
  )
}

export const PREVIEWS: Readonly<Record<string, Preview>> = {
  accent: {
    render: ({ width, appearance }) => (
      <box flexDirection="column" flexShrink={0} gap={1}>
        <Swatches chosen={appearance.accent} />
        <MarkdownView source={PROSE} width={width} />
        <FencedBlock language="ts" source={FENCE} width={width} />
      </box>
    ),
  },
  density: {
    render: ({ width }) => (
      <box flexDirection="column" flexShrink={0} gap={1}>
        <FencedBlock language="ts" filename="theme.ts" source={FENCE} width={width} />
        {DIFF === undefined ? null : <InlineDiff file={DIFF} width={width} />}
      </box>
    ),
  },
  composer: {
    render: ({ width }) => <ComposerPreview width={width} />,
  },
}

export const previewFor = (id: string): Preview | undefined => PREVIEWS[id]
