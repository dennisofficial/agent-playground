import {
  ESettingId,
  ESettingKind,
  parseUnifiedDiff,
  type DiffFile,
  type ResolvedSetting,
} from '@dltech/atlas-core'
import React from 'react'

import { accentHex } from '../../accents'
import type { Appearance } from '../../appearance'
import { useDraft } from '../../hooks/use-draft'
import { FencedBlock } from '../../markdown/fenced-block'
import { theme } from '../../theme'
import { Composer, EComposerTone } from '../composer'
import { InlineDiff } from '../diff/inline-diff'

export type SettingPreview = {
  render: (args: {
    width: number
    appearance: Appearance
    setting: ResolvedSetting
  }) => React.ReactNode
}

export const CHOSEN = '●'

export const UNCHOSEN = '○'

const namesOf = (setting: ResolvedSetting): readonly string[] =>
  setting.definition.kind === ESettingKind.Choice
    ? setting.definition.options.map((option) => option.value)
    : []

function Swatches(props: { chosen: string; setting: ResolvedSetting }): React.ReactNode {
  return (
    <box flexDirection="row" flexShrink={0} gap={2}>
      {namesOf(props.setting).map((name) => (
        <text key={name} fg={name === props.chosen ? accentHex(name) : theme.dim}>
          {`${name === props.chosen ? CHOSEN : UNCHOSEN} ${name}`}
        </text>
      ))}
    </box>
  )
}

export const DIFF_PATH = 'src/ui/theme.ts'

const FENCE_LANGUAGE = 'ts'

const FENCE = ['const rail = theme.accent', 'const fill = theme.panelBg'].join('\n')

const PATCH = [
  `diff --git a/${DIFF_PATH} b/${DIFF_PATH}`,
  `--- a/${DIFF_PATH}`,
  `+++ b/${DIFF_PATH}`,
  '@@ -11,6 +11,6 @@ export const theme: Palette = {',
  "   appBg: '#282422',",
  '-  accent: ACCENT,',
  '+  accent: accentHex(chosen),',
  "   dim: '#6b625c',",
].join('\n')

const DENSITY_DIFF: DiffFile | undefined = parseUnifiedDiff(PATCH)[0]

export const COMPOSER_DRAFT = 'the draft, edged the way you picked'

const COMPOSER_ROWS = 2

function ComposerScene(props: { width: number }): React.ReactNode {
  const draft = useDraft()

  return (
    <Composer
      draft={draft}
      width={props.width}
      tone={EComposerTone.Idle}
      placeholder={COMPOSER_DRAFT}
      maxRows={COMPOSER_ROWS}
      focused={false}
    />
  )
}

const PREVIEWS: Readonly<Record<string, SettingPreview>> = {
  [ESettingId.Accent]: {
    render: ({ appearance, setting }) => (
      <Swatches chosen={appearance.accent} setting={setting} />
    ),
  },
  [ESettingId.ComposerEdge]: {
    render: ({ width }) => <ComposerScene width={width} />,
  },
  [ESettingId.BlockPadding]: {
    render: ({ width }) => (
      <box flexDirection="column" flexShrink={0} gap={1}>
        <FencedBlock language={FENCE_LANGUAGE} filename="theme.ts" source={FENCE} width={width} />
        {DENSITY_DIFF === undefined ? null : <InlineDiff file={DENSITY_DIFF} width={width} />}
      </box>
    ),
  },
}

export const previewFor = (id: string): SettingPreview | undefined => PREVIEWS[id]
