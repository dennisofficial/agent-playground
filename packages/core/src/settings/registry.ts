import { ESettingPage, type SettingDefinition, type SettingPage } from './definition'
import { ESettingKind } from './value'

export const SETTING_PAGES: readonly SettingPage[] = [
  { id: ESettingPage.General, label: 'general' },
  { id: ESettingPage.Appearance, label: 'appearance' },
]

export enum ESettingId {
  SmoothStreaming = 'transcript.smoothStreaming',
  SidebarWidth = 'sidebar.width',
  Accent = 'appearance.accent',
  BlockPadding = 'appearance.blockPadding',
}

export const ATLAS_SETTINGS: readonly SettingDefinition[] = [
  {
    id: ESettingId.SmoothStreaming,
    page: ESettingPage.General,
    group: 'Transcript',
    label: 'Smooth streaming',
    description:
      'Reveal assistant text at reading pace instead of the rate the model emits it. Turning this off shows every chunk the moment it lands.',
    environmentVariable: 'ATLAS_SMOOTH_STREAMING',
    kind: ESettingKind.Toggle,
    fallback: true,
  },
  {
    id: ESettingId.SidebarWidth,
    page: ESettingPage.General,
    group: 'Layout',
    label: 'Sidebar width',
    description:
      'How many columns every side pane takes: the transcript sidebar, the model picker, and the explanation beside these settings. The sidebar docks on its own above 120 columns and floats over the transcript below that.',
    environmentVariable: 'ATLAS_SIDEBAR_WIDTH',
    kind: ESettingKind.Range,
    fallback: 42,
    minimum: 30,
    maximum: 64,
    step: 2,
    unit: ' cols',
  },
  {
    id: ESettingId.Accent,
    page: ESettingPage.Appearance,
    group: 'Colour',
    label: 'Accent',
    description:
      'The one hue that carries the harness through the whole app: block marks, the composer rail, the caret and inline code.',
    environmentVariable: 'ATLAS_ACCENT',
    kind: ESettingKind.Choice,
    fallback: 'clay',
    options: [
      { value: 'clay', label: 'clay', detail: 'shipped' },
      { value: 'slate', label: 'slate' },
      { value: 'moss', label: 'moss' },
      { value: 'plum', label: 'plum' },
    ],
  },
  {
    id: ESettingId.BlockPadding,
    page: ESettingPage.Appearance,
    group: 'Density',
    label: 'Block padding',
    description:
      'How much room a banded slab spends on its own chrome: code fences, diffs and failed turns. Comfort opens the band on a half row of its own and seams it off the body below; compact starts on the header row and runs straight into the content.',
    environmentVariable: 'ATLAS_BLOCK_PADDING',
    kind: ESettingKind.Choice,
    fallback: 'comfort',
    options: [
      { value: 'comfort', label: 'comfort', detail: 'shipped' },
      { value: 'compact', label: 'compact' },
    ],
  },
]
