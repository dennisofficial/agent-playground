declare const ATLAS_VERSION: string | undefined
declare const ATLAS_RELEASE_REPO: string | undefined
declare const ATLAS_BUILD_REPO: string | undefined
declare const ATLAS_BUILD_STAMP: string | undefined

export enum EBuildKind {
  Release = 'release',
  Dev = 'dev',
  Source = 'source',
}

export type BuildInfo =
  | { readonly kind: EBuildKind.Release; readonly version: string; readonly releaseRepo: string | null }
  | { readonly kind: EBuildKind.Dev; readonly repo: string; readonly stamp: string }
  | { readonly kind: EBuildKind.Source }

const present = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value

export function buildInfo(): BuildInfo {
  const version = typeof ATLAS_VERSION === 'undefined' ? undefined : present(ATLAS_VERSION)
  if (version !== undefined) {
    const releaseRepo = typeof ATLAS_RELEASE_REPO === 'undefined' ? undefined : ATLAS_RELEASE_REPO
    return { kind: EBuildKind.Release, version, releaseRepo: releaseRepo ?? null }
  }

  const repo = typeof ATLAS_BUILD_REPO === 'undefined' ? undefined : present(ATLAS_BUILD_REPO)
  const stamp = typeof ATLAS_BUILD_STAMP === 'undefined' ? undefined : present(ATLAS_BUILD_STAMP)
  if (repo !== undefined && stamp !== undefined) {
    return { kind: EBuildKind.Dev, repo, stamp }
  }

  return { kind: EBuildKind.Source }
}
