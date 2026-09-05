export enum EFenceWrap {
  Text = 'text',
  Never = 'never',
  All = 'all',
}

export const SHIPPED_FENCE_WRAP = EFenceWrap.Text

let current: EFenceWrap = SHIPPED_FENCE_WRAP

export const fenceWrap = (): EFenceWrap => current

export function applyFenceWrap(next: EFenceWrap): void {
  current = next
}

export const fenceWrapOf = (value: string): EFenceWrap => {
  if (value === EFenceWrap.Never) return EFenceWrap.Never
  if (value === EFenceWrap.All) return EFenceWrap.All
  return EFenceWrap.Text
}

const PROSE_LANGUAGES: readonly string[] = [
  'md',
  'markdown',
  'txt',
  'text',
  'plaintext',
  'bash',
  'sh',
  'shell',
  'zsh',
]

export function wrapsFence(language: string): boolean {
  if (current === EFenceWrap.All) return true
  if (current === EFenceWrap.Never) return false
  return PROSE_LANGUAGES.includes(language.toLowerCase())
}
