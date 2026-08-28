export type Frontmatter = { fields: ReadonlyMap<string, string>; body: string }

const FENCE = '---'

const unquoted = (value: string): string => {
  const trimmed = value.trim()
  const head = trimmed[0]
  if (head === undefined) return trimmed
  if ((head === '"' || head === "'") && trimmed.endsWith(head) && trimmed.length > 1) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function splitFrontmatter(text: string): Frontmatter {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== FENCE) return { fields: new Map(), body: text }

  const closing = lines.findIndex((line, at) => at > 0 && line.trim() === FENCE)
  if (closing === -1) return { fields: new Map(), body: text }

  const fields = new Map<string, string>()
  for (const line of lines.slice(1, closing)) {
    const at = line.indexOf(':')
    if (at <= 0) continue

    const key = line.slice(0, at).trim()
    if (key === '') continue
    fields.set(key, unquoted(line.slice(at + 1)))
  }

  return { fields, body: lines.slice(closing + 1).join('\n').replace(/^\n+/, '') }
}
