export const glyph = {
  user: '❯',
  block: '⏺',
  result: '⎿',
  thinking: '✻',
  swap: '⤿',
  selected: '❯',
  marker: '▸',
  active: '⏺',
  available: '○',
  unseen: '●',
  seen: '·',
  warning: '⚠',
  failed: '✗',
  passed: '✓',
  image: '▣',
  skill: '◆',
  file: '⬚',
  copy: '⧉',
  retry: '↻',
  home: '⌂',
  worktree: '⑂',
} as const

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

export const SPINNER_FRAME_MS = 80

export function spinnerFrame(nowMs: number): string {
  const index = Math.floor(nowMs / SPINNER_FRAME_MS) % SPINNER_FRAMES.length
  return SPINNER_FRAMES[index] as string
}
