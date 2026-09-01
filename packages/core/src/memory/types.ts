export enum EMemoryType {
  User = 'user',
  Feedback = 'feedback',
  Project = 'project',
  Reference = 'reference',
}

const TYPE_VALUES: readonly string[] = Object.values(EMemoryType)

export const isMemoryType = (value: string): value is EMemoryType => TYPE_VALUES.includes(value)

export function parseMemoryType(raw: unknown): EMemoryType | undefined {
  if (typeof raw !== 'string') return undefined
  return TYPE_VALUES.includes(raw) ? (raw as EMemoryType) : undefined
}
