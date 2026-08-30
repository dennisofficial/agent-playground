import { ESettingPage, type SettingDefinition, type SettingPage } from './definition'
import { ESettingKind } from './value'

export const SETTING_PAGES: readonly SettingPage[] = [
  { id: ESettingPage.General, label: 'general' },
  { id: ESettingPage.Appearance, label: 'appearance' },
]

export enum ESettingId {
  SmoothStreaming = 'transcript.smoothStreaming',
  ThinkingBlocks = 'transcript.thinkingBlocks',
  SidebarWidth = 'sidebar.width',
  ProjectInstructions = 'context.projectInstructions',
  UserInstructions = 'context.userInstructions',
  InstructionFilenames = 'context.filenames',
  NestedInstructions = 'context.nestedInstructions',
  ReloadInstructions = 'context.reload',
  AutoCompact = 'context.autoCompact',
  FooterMeters = 'usage.meters',
  WarnFiveHour = 'usage.warnFiveHour',
  WarnWeekly = 'usage.warnWeekly',
  Accent = 'appearance.accent',
  BlockPadding = 'appearance.blockPadding',
  ComposerEdge = 'appearance.composerEdge',
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
    id: ESettingId.ThinkingBlocks,
    page: ESettingPage.General,
    group: 'Transcript',
    label: 'Thinking blocks',
    description:
      'What the transcript keeps of the reasoning behind an answer. Keep leaves a summary row behind that unfolds into the whole thought; while streaming shows the live tail and holds it until something lands under it — the answer, or the end of the turn; hide never renders reasoning at all. Adjacent thoughts always fold into one block.',
    environmentVariable: 'ATLAS_THINKING_BLOCKS',
    kind: ESettingKind.Choice,
    fallback: 'keep',
    options: [
      { value: 'keep', label: 'keep', detail: 'shipped' },
      { value: 'stream', label: 'while streaming' },
      { value: 'hidden', label: 'hide' },
    ],
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
    id: ESettingId.ProjectInstructions,
    page: ESettingPage.General,
    group: 'Project context',
    label: 'Project instructions',
    description:
      'Load the instruction files a repository carries for its agents, walking the workspace root down to the working directory so that a deeper file overrides a shallower one.',
    environmentVariable: 'ATLAS_PROJECT_INSTRUCTIONS',
    kind: ESettingKind.Toggle,
    fallback: true,
  },
  {
    id: ESettingId.UserInstructions,
    page: ESettingPage.General,
    group: 'Project context',
    label: 'Personal instructions',
    description:
      'Also load the instruction files in your home directory, which apply to every project. They are read before the repository, so anything the repository says wins.',
    environmentVariable: 'ATLAS_USER_INSTRUCTIONS',
    kind: ESettingKind.Toggle,
    fallback: true,
  },
  {
    id: ESettingId.InstructionFilenames,
    page: ESettingPage.General,
    group: 'Project context',
    label: 'Instruction filenames',
    description:
      'Which filenames count as instructions. AGENTS.md is the cross-vendor convention and CLAUDE.md the Claude-specific one; when both are read, CLAUDE.md is loaded second and therefore wins a disagreement. A .local.md sibling of either is read last and is never checked in.',
    environmentVariable: 'ATLAS_INSTRUCTION_FILENAMES',
    kind: ESettingKind.Choice,
    fallback: 'both',
    options: [
      { value: 'both', label: 'both', detail: 'shipped' },
      { value: 'claude', label: 'CLAUDE.md' },
      { value: 'agents', label: 'AGENTS.md' },
    ],
  },
  {
    id: ESettingId.NestedInstructions,
    page: ESettingPage.General,
    group: 'Project context',
    label: 'Nested instructions',
    description:
      'Pull in the instruction file above a path the moment a tool touches it, rather than only the ones on the way to the working directory. This is what lets a package deep in a monorepo state its own rules without every session paying for them.',
    environmentVariable: 'ATLAS_NESTED_INSTRUCTIONS',
    kind: ESettingKind.Toggle,
    fallback: true,
  },
  {
    id: ESettingId.ReloadInstructions,
    page: ESettingPage.General,
    group: 'Project context',
    label: 'Reload on change',
    description:
      'Re-read the instruction files at every turn, so editing one takes effect in the conversation you are already in. Unchanged files cost nothing; a changed one is appended again and supersedes what the model was reading. Turning this off freezes the instructions as they were when the conversation opened.',
    environmentVariable: 'ATLAS_RELOAD_INSTRUCTIONS',
    kind: ESettingKind.Toggle,
    fallback: true,
  },
  {
    id: ESettingId.AutoCompact,
    page: ESettingPage.General,
    group: 'Context window',
    label: 'Compact automatically at',
    description:
      'How full the context window may get before Atlas summarises the older turns without being asked. It checks when a turn ends, so a turn is never interrupted to do it, and it compacts mid-turn only when a step would otherwise overflow the window outright. Set to zero to compact only when you ask with /compact.',
    environmentVariable: 'ATLAS_AUTO_COMPACT',
    kind: ESettingKind.Range,
    fallback: 90,
    minimum: 0,
    maximum: 100,
    step: 5,
    unit: '%',
  },
  {
    id: ESettingId.FooterMeters,
    page: ESettingPage.General,
    group: 'Usage meters',
    label: 'Meters in the footer',
    description:
      'Which meters the footer carries. The context meter reports the window the current conversation occupies; the session and weekly meters report how much of the account\'s own rate limits have been spent, read from Anthropic rather than counted here. Narrowing this does not stop Atlas reading them, it stops the footer spelling them out.',
    environmentVariable: 'ATLAS_FOOTER_METERS',
    kind: ESettingKind.Choice,
    fallback: 'all',
    options: [
      { value: 'all', label: 'all', detail: 'ctx · 5h · wk' },
      { value: 'session', label: 'session', detail: 'ctx · 5h' },
      { value: 'context', label: 'context only', detail: 'ctx' },
    ],
  },
  {
    id: ESettingId.WarnFiveHour,
    page: ESettingPage.General,
    group: 'Usage meters',
    label: 'Warn on the session window at',
    description:
      'How much of the five-hour window may be spent before the footer stops being ambient and starts colouring the figure. The two bands above this one are spaced across whatever headroom is left, so moving this moves all of them.',
    environmentVariable: 'ATLAS_WARN_FIVE_HOUR',
    kind: ESettingKind.Range,
    fallback: 65,
    minimum: 0,
    maximum: 100,
    step: 5,
    unit: '%',
  },
  {
    id: ESettingId.WarnWeekly,
    page: ESettingPage.General,
    group: 'Usage meters',
    label: 'Warn on the weekly window at',
    description:
      'The same threshold for the seven-day window. It earns attention later than the session window by default, because a two-thirds-spent week is simply Thursday, where a two-thirds-spent five hours is the one that walls you mid-task.',
    environmentVariable: 'ATLAS_WARN_WEEKLY',
    kind: ESettingKind.Range,
    fallback: 70,
    minimum: 0,
    maximum: 100,
    step: 5,
    unit: '%',
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
  {
    id: ESettingId.ComposerEdge,
    page: ESettingPage.Appearance,
    group: 'Composer',
    label: 'Composer edge',
    description:
      'How the draft separates itself from the transcript above it. Slab gives the composer a darker ground of its own and opens it on a half row, marked down the left by the accent rail. Bordered drops that second ground and draws a thin accent frame on all four sides instead, with the session title set into the top edge. Claude keeps those two rules and drops the sides, leading the draft with a prompt caret at the margin.',
    environmentVariable: 'ATLAS_COMPOSER_EDGE',
    kind: ESettingKind.Choice,
    fallback: 'slab',
    options: [
      { value: 'slab', label: 'slab', detail: 'shipped' },
      { value: 'bordered', label: 'bordered' },
      { value: 'claude', label: 'claude' },
    ],
  },
]
