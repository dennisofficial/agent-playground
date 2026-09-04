import { readdir, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

const MAX_SUGGESTIONS = 8
const MAX_ENTRY_LENGTH = 80

function nameDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)

  for (let row = 1; row <= a.length; row++) {
    const current: number[] = [row]
    for (let column = 1; column <= b.length; column++) {
      const substitution = (previous[column - 1] ?? 0) + (a[row - 1] === b[column - 1] ? 0 : 1)
      current[column] = Math.min((previous[column] ?? 0) + 1, (current[column - 1] ?? 0) + 1, substitution)
    }
    previous = current
  }

  return previous[b.length] ?? 0
}

async function deepestExistingDirectoryOf(path: string): Promise<string | undefined> {
  let candidate = dirname(path)

  for (;;) {
    const stats = await stat(candidate).catch(() => null)
    if (stats?.isDirectory()) return candidate

    const parent = dirname(candidate)
    if (parent === candidate) return undefined
    candidate = parent
  }
}

async function closestEntriesOf({
  directory,
  target,
}: {
  directory: string
  target: string
}): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const wanted = target.toLowerCase()

  return entries
    .map((entry) => ({
      label: entry.isDirectory() ? `${entry.name}/` : entry.name,
      distance: nameDistance(entry.name.toLowerCase(), wanted),
    }))
    .sort((a, b) => a.distance - b.distance || a.label.localeCompare(b.label))
    .slice(0, MAX_SUGGESTIONS)
    .map(({ label }) => (label.length > MAX_ENTRY_LENGTH ? `${label.slice(0, MAX_ENTRY_LENGTH)}…` : label))
}

export async function missingPathReason({ path }: { path: string }): Promise<string> {
  const directory = await deepestExistingDirectoryOf(path)
  if (directory === undefined) return `File does not exist: ${path}`

  const entries = await closestEntriesOf({ directory, target: basename(path) })
  const listing =
    entries.length === 0 ? 'it is empty' : `its closest entries are: ${entries.join(', ')}`

  return directory === dirname(path)
    ? `File does not exist: ${path}. ${directory} is there; ${listing}`
    : `File does not exist: ${path}. ${directory} is the deepest directory that exists on that path; ${listing}`
}
