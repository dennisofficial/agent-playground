import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export function repositoryRootOf({ from }: { from: string }): string {
  const start = resolve(from)
  let current = start

  while (true) {
    if (existsSync(join(current, '.git'))) return current

    const parent = dirname(current)
    if (parent === current) return start
    current = parent
  }
}
