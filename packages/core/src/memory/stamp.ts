const FENCE = '---'

export const RECORDED_KEY = 'recorded'

const newlineOf = (content: string): string => (content.includes('\r\n') ? '\r\n' : '\n')

const closingFenceAt = (lines: readonly string[]): number =>
  lines.findIndex((line, at) => at > 0 && line.trim() === FENCE)

const recordedLineAt = (args: { lines: readonly string[]; closing: number }): number =>
  args.lines.findIndex(
    (line, at) => at > 0 && at < args.closing && line.startsWith(`${RECORDED_KEY}:`),
  )

export function withRecordedDate({
  content,
  date,
}: {
  content: string
  date: string
}): string {
  const newline = newlineOf(content)
  const lines = content.split(newline)
  if (lines[0]?.trim() !== FENCE) return content

  const closing = closingFenceAt(lines)
  if (closing < 0) return content

  const stamped = `${RECORDED_KEY}: ${date}`
  const existing = recordedLineAt({ lines, closing })

  if (existing < 0) {
    return [...lines.slice(0, closing), stamped, ...lines.slice(closing)].join(newline)
  }

  if (lines[existing] === stamped) return content

  return lines.map((line, at) => (at === existing ? stamped : line)).join(newline)
}
