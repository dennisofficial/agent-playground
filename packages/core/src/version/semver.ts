export type Semver = {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: string | null
}

export function parseSemver(text: string): Semver | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text)
  if (match === null) return null

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  }
}

export function versionFromTag(args: { tag: string; prefix: string }): Semver | null {
  if (!args.tag.startsWith(args.prefix)) return null
  return parseSemver(args.tag.slice(args.prefix.length))
}

export function compareSemver(a: Semver, b: Semver): number {
  for (const part of ['major', 'minor', 'patch'] as const) {
    if (a[part] !== b[part]) return a[part] - b[part]
  }

  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === null) return 1
  if (b.prerelease === null) return -1
  return a.prerelease < b.prerelease ? -1 : 1
}

export function isNewerSemver(args: { candidate: Semver; current: Semver }): boolean {
  return compareSemver(args.candidate, args.current) > 0
}

export function formatSemver(version: Semver): string {
  const base = `${version.major}.${version.minor}.${version.patch}`
  return version.prerelease === null ? base : `${base}-${version.prerelease}`
}
