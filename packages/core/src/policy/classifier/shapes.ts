import { basenameOf, isUnderPath, normalisePath } from './path-set'

const TEMPORARY_ROOTS: readonly string[] = ['/tmp', '/private/tmp', '/var/tmp', '/var/folders']

const HOME_ROOTS: ReadonlySet<string> = new Set(['Users', 'home'])

const SECRET_BASENAMES: ReadonlySet<string> = new Set([
  '.netrc',
  '.npmrc',
  '.pgpass',
  'credentials',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
])

const SECRET_DIRECTORIES: ReadonlySet<string> = new Set(['.aws', '.gnupg', '.ssh'])

const SECRET_SUFFIXES: readonly string[] = ['.p12', '.pem', '.pfx']

const DOWNLOADED_DIRECTORIES: ReadonlySet<string> = new Set(['Downloads', 'node_modules'])

const SECRET_LITERALS =
  /(sk-[A-Za-z0-9_-]{8}|ghp_[A-Za-z0-9]{8}|github_pat_[A-Za-z0-9_]{8}|AKIA[0-9A-Z]{8})/

export function segmentsOf({ path }: { path: string }): readonly string[] {
  return normalisePath({ path })
    .split('/')
    .filter((segment) => segment.length > 0)
}

export function hasSegment({
  path,
  segments,
}: {
  path: string
  segments: ReadonlySet<string>
}): boolean {
  return segmentsOf({ path }).some((segment) => segments.has(segment))
}

export function homeDotDirectory({ path }: { path: string }): string | undefined {
  const normalised = normalisePath({ path })
  const parts = segmentsOf({ path: normalised })

  if (parts[0] === '~') return parts[1]
  if (!normalised.startsWith('/')) return undefined
  if (parts[0] === undefined || !HOME_ROOTS.has(parts[0])) return undefined
  return parts[2]
}

export function insideTemporaryRoot({ path }: { path: string }): boolean {
  return TEMPORARY_ROOTS.some((directory) => isUnderPath({ directory, path }))
}

export function looksSecretShaped({ path }: { path: string }): boolean {
  const name = basenameOf({ path })
  if (name === '.env' || name.startsWith('.env.')) return true
  if (SECRET_BASENAMES.has(name)) return true
  if (SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true
  return hasSegment({ path, segments: SECRET_DIRECTORIES })
}

export function looksDownloaded({ path }: { path: string }): boolean {
  return hasSegment({ path, segments: DOWNLOADED_DIRECTORIES })
}

export function looksRegenerable({
  path,
  names,
}: {
  path: string
  names: readonly string[]
}): boolean {
  return hasSegment({ path, segments: new Set(names) })
}

export function namesASecretLiteral({ text }: { text: string }): boolean {
  return SECRET_LITERALS.test(text)
}
