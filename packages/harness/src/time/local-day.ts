const padded = (value: number, width: number): string => `${value}`.padStart(width, '0')

const parsed = (instant: string): Date | null => {
  const at = new Date(instant)
  return Number.isNaN(at.getTime()) ? null : at
}

export function localDayOf(instant: string): string {
  const at = parsed(instant)
  if (at === null) return ''

  return `${padded(at.getFullYear(), 4)}-${padded(at.getMonth() + 1, 2)}-${padded(at.getDate(), 2)}`
}

export function localWeekdayOf(instant: string): string {
  const at = parsed(instant)
  if (at === null) return ''

  return at.toLocaleDateString('en-US', { weekday: 'long' })
}
