import {
  compareSemver,
  formatSemver,
  isNewerSemver,
  parseSemver,
  versionFromTag,
  type Semver,
} from '@dltech/atlas-core'

import { buildInfo, EBuildKind } from '../build/info'
import { repoRootOf, sourceStateStamp } from '../build/stamp'
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

const run = async (cmd: readonly string[], timeoutMs = 15_000): Promise<string | null> => {
  try {
    const proc = Bun.spawn([...cmd], { stdout: 'pipe', stderr: 'ignore' })
    const timer = setTimeout(() => proc.kill(), timeoutMs)
    timer.unref?.()
    const text = await new Response(proc.stdout).text()
    const code = await proc.exited
    clearTimeout(timer)
    return code === 0 ? text : null
  } catch {
    return null
  }
}

async function releaseTagsOf(repo: string): Promise<readonly string[] | null> {
  const out = await run(['gh', 'api', `repos/${repo}/releases?per_page=50`, '--jq', '.[].tag_name'])
  if (out === null) return null

  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export function sourceBehindNotice(args: { behind: number; upstream: string }): string | null {
  if (args.behind <= 0) return null

  const commits = args.behind === 1 ? '1 commit' : `${args.behind} commits`
  return `atlas-dev is ${commits} behind ${args.upstream} — git pull in the atlas checkout to update`
}

export type SourceBehind = {
  readonly behind: number
  readonly upstream: string
}

export type SourceStaleness = {
  readonly check: () => Promise<void>
  readonly stale: () => Promise<boolean>
}

export const SOURCE_STALE_NOTICE =
  'this atlas-dev session is stale — the source tree has moved; /restart to pick it up'

export function createSourceStaleness(args: {
  launchStamp: string
  readStamp: () => Promise<string | null>
  announce: (text: string) => void
}): SourceStaleness {
  let announced = false

  const moved = async (): Promise<boolean> => {
    const stamp = await args.readStamp()
    return stamp !== null && stamp !== args.launchStamp
  }

  return {
    stale: moved,
    check: async () => {
      if (announced) return
      if (!(await moved())) return

      announced = true
      args.announce(SOURCE_STALE_NOTICE)
    },
  }
}

export async function sourceStalenessProbe(): Promise<SourceStaleness | null> {
  if (buildInfo().kind !== EBuildKind.Source) return null
  if (process.env.ATLAS_DEV !== '1') return null

  const repo = await repoRootOf(import.meta.dir)
  if (repo === null) return null

  const launchStamp = await sourceStateStamp({ repo })
  if (launchStamp === null) return null

  return createSourceStaleness({
    launchStamp,
    readStamp: () => sourceStateStamp({ repo }),
    announce: (text) => notify({ key: 'source-stale', tone: ENoticeTone.Info, sticky: true, text }),
  })
}

async function probeSourceBehind(repo: string): Promise<SourceBehind | null> {
  await run(['git', '-C', repo, 'fetch', '--quiet'])

  const upstream = await run(['git', '-C', repo, 'rev-parse', '--abbrev-ref', '@{upstream}'])
  if (upstream === null) return null

  const count = await run(['git', '-C', repo, 'rev-list', '--count', 'HEAD..@{upstream}'])
  const behind = count === null ? Number.NaN : Number(count.trim())
  if (Number.isNaN(behind)) return null

  return { behind, upstream: upstream.trim() }
}

export async function checkForUpdate(): Promise<void> {
  const build = buildInfo()

  if (build.kind === EBuildKind.Source) {
    if (process.env.ATLAS_DEV !== '1') return

    const repo = await repoRootOf(import.meta.dir)
    if (repo === null) return

    const state = await probeSourceBehind(repo)
    if (state === null) return

    const text = sourceBehindNotice(state)
    if (text === null) return

    notify({ key: 'source-behind', tone: ENoticeTone.Info, sticky: true, text })
    return
  }

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
