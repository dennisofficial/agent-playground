const separator = '/'

const isAbsolute = (path: string): boolean => path.startsWith(separator)

const isHomeRooted = (path: string): boolean => path === '~' || path.startsWith('~/')

export function normalisePath({ path }: { path: string }): string {
  const absolute = isAbsolute(path)
  const parts: string[] = []

  for (const part of path.split(separator)) {
    if (part === '' || part === '.') continue

    if (part !== '..') {
      parts.push(part)
      continue
    }

    const last = parts[parts.length - 1]
    if (last !== undefined && last !== '..') {
      parts.pop()
      continue
    }

    if (absolute) continue
    parts.push('..')
  }

  const joined = parts.join(separator)
  if (absolute) return `${separator}${joined}`
  return joined === '' ? '.' : joined
}

export function resolveAgainst({ base, path }: { base: string; path: string }): string {
  if (isHomeRooted(path)) return path
  if (isAbsolute(path)) return normalisePath({ path })
  return normalisePath({ path: `${base}${separator}${path}` })
}

export function isUnderPath({ directory, path }: { directory: string; path: string }): boolean {
  const root = normalisePath({ path: directory })
  const target = normalisePath({ path })

  if (root === target) return true

  if (root === '.') return !isAbsolute(target) && target !== '..' && !target.startsWith('../')

  const prefix = root.endsWith(separator) ? root : `${root}${separator}`
  return target.startsWith(prefix)
}

export function parentOf({ path }: { path: string }): string | undefined {
  const normalised = normalisePath({ path })
  if (normalised === separator || normalised === '.' || normalised === '..') return undefined

  const cut = normalised.lastIndexOf(separator)
  if (cut === -1) return '.'
  if (cut === 0) return separator
  return normalised.slice(0, cut)
}

export function basenameOf({ path }: { path: string }): string {
  const normalised = normalisePath({ path })
  const cut = normalised.lastIndexOf(separator)
  if (cut === -1) return normalised
  return normalised.slice(cut + 1)
}
