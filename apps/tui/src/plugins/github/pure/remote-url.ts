export enum EForge {
  GitHub = 'github',
  Other = 'other',
  Unknown = 'unknown',
}

export type RemoteRepository = { host: string; owner: string; repo: string }

const GIT_SUFFIX = '.git'

const GITHUB_HOST = 'github.com'

const GITHUB_ENTERPRISE_SUFFIX = '.ghe.com'

const KNOWN_OTHER_HOSTS = new Set([
  'gitlab.com',
  'bitbucket.org',
  'git.sr.ht',
  'dev.azure.com',
  'codeberg.org',
])

type Authority = { authority: string; path: string }

const trimmed = (url: string): string => {
  const withoutSlashes = url.trim().replace(/\/+$/, '')
  return withoutSlashes.endsWith(GIT_SUFFIX)
    ? withoutSlashes.slice(0, -GIT_SUFFIX.length)
    : withoutSlashes
}

const afterScheme = (url: string): Authority | null => {
  const rest = url.slice(url.indexOf('://') + '://'.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null

  return { authority: rest.slice(0, slash), path: rest.slice(slash + 1) }
}

const WINDOWS_DRIVE = /^[a-zA-Z]$/

/** `C:/src/repo` is a path git really writes, and it is scp-shaped: a drive letter is not a host. */
const scpForm = (url: string): Authority | null => {
  const colon = url.indexOf(':')
  if (colon <= 0) return null

  const authority = url.slice(0, colon)
  if (WINDOWS_DRIVE.test(authority)) return null

  return { authority, path: url.slice(colon + 1) }
}

const hostOf = (authority: string): string => {
  const afterUser = authority.slice(authority.lastIndexOf('@') + 1)
  const colon = afterUser.indexOf(':')
  return (colon === -1 ? afterUser : afterUser.slice(0, colon)).toLowerCase()
}

export function parseRemoteUrl({ url }: { url: string }): RemoteRepository | null {
  const cleaned = trimmed(url)
  if (cleaned.length === 0) return null

  const split = cleaned.includes('://') ? afterScheme(cleaned) : scpForm(cleaned)
  if (split === null) return null

  const host = hostOf(split.authority)
  if (host.length === 0) return null

  const segments = split.path.split('/').filter((segment) => segment.length > 0)
  const repo = segments.at(-1)
  if (repo === undefined || segments.length < 2) return null

  return { host, owner: segments.slice(0, -1).join('/'), repo }
}

export function forgeOfHost({ host }: { host: string }): EForge {
  const lowered = host.toLowerCase()
  if (lowered === GITHUB_HOST || lowered.endsWith(GITHUB_ENTERPRISE_SUFFIX)) return EForge.GitHub
  if (KNOWN_OTHER_HOSTS.has(lowered)) return EForge.Other

  return EForge.Unknown
}
