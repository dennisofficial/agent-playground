import {
  compareSemver,
  formatSemver,
  isNewerSemver,
  parseSemver,
  versionFromTag,
  type Semver,
} from '@dltech/atlas-core'

import { buildInfo, EBuildKind } from '../build/info'
import { sourceStateStamp } from '../build/stamp'
import { ENoticeTone, notify } from '../ui/notice-store'

export const RELEASE_TAG_PREFIX = 'tui-v'

export type ReleaseInfo = {
  readonly tag: string
  readonly version: Semver
}

export function latestRelease(args: {
  tags: readonly string[]
  prefix: string
}): ReleaseInfo | null {
  let best: ReleaseInfo | null = null
  for (const tag of args.tags) {
    const version = versionFromTag({ tag, prefix: args.prefix })
    if (version === null) continue
    if (best === null || compareSemver(version, best.version) > 0) best = { tag, version }
  }
  return best
}

export function releaseNotice(args: { current: string; latest: ReleaseInfo }): string | null {
  const current = parseSemver(args.current)
  if (current === null) return null
  if (!isNewerSemver({ candidate: args.latest.version, current })) return null

  return `atlas update: v${formatSemver(args.latest.version)} available (running v${formatSemver(current)})`
}

const gh = async (args: readonly string[]): Promise<string | null> => {
  try {
    const proc = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'ignore' })
    const text = await new Response(proc.stdout).text()
    return (await proc.exited) === 0 ? text : null
  } catch {
    return null
  }
}

async function releaseTagsOf(repo: string): Promise<readonly string[] | null> {
  const out = await gh(['api', `repos/${repo}/releases?per_page=50`, '--jq', '.[].tag_name'])
  if (out === null) return null

  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export async function checkForUpdate(): Promise<void> {
  const build = buildInfo()

  if (build.kind === EBuildKind.Dev) {
    const stamp = await sourceStateStamp({ repo: build.repo })
    if (stamp === null || stamp === build.stamp) return

    notify({
      key: 'build-stale',
      tone: ENoticeTone.Info,
      sticky: true,
      text: 'this atlas build is stale — the source tree has moved; bun run build to refresh',
    })
    return
  }

  if (build.kind !== EBuildKind.Release || build.releaseRepo === null) return

  const tags = await releaseTagsOf(build.releaseRepo)
  if (tags === null) return

  const latest = latestRelease({ tags, prefix: RELEASE_TAG_PREFIX })
  if (latest === null) return

  const text = releaseNotice({ current: build.version, latest })
  if (text === null) return

  notify({ key: 'release-available', tone: ENoticeTone.Info, sticky: true, text })
}
