import { splitLines } from './file-text'

const CONTEXT_LINES = 3

type LineGroup = { from: number; to: number; lines: readonly string[] }

type LinePair = { oldLines: readonly string[]; newLines: readonly string[] }

function commonHeadLength(pair: LinePair): number {
  const shortest = Math.min(pair.oldLines.length, pair.newLines.length)
  let count = 0
  while (count < shortest && pair.oldLines[count] === pair.newLines[count]) count += 1

  return count
}

function commonTailLength(args: LinePair & { head: number }): number {
  const available = Math.min(args.oldLines.length, args.newLines.length) - args.head
  let count = 0
  while (count < available) {
    const older = args.oldLines[args.oldLines.length - 1 - count]
    const newer = args.newLines[args.newLines.length - 1 - count]
    if (older !== newer) break
    count += 1
  }

  return count
}

function alignedGroups(args: LinePair & { from: number; to: number }): LineGroup[] {
  const groups: LineGroup[] = []
  let index = args.from

  while (index <= args.to) {
    if (args.oldLines[index] === args.newLines[index]) {
      index += 1
      continue
    }

    const from = index
    while (index <= args.to && args.oldLines[index] !== args.newLines[index]) index += 1
    groups.push({ from, to: index - 1, lines: args.newLines.slice(from, index) })
  }

  return groups
}

function changedGroups(pair: LinePair): LineGroup[] {
  const head = commonHeadLength(pair)
  const tail = commonTailLength({ ...pair, head })
  const oldTo = pair.oldLines.length - 1 - tail
  const newTo = pair.newLines.length - 1 - tail

  if (head > oldTo && head > newTo) return []
  if (oldTo === newTo) return alignedGroups({ ...pair, from: head, to: oldTo })

  return [{ from: head, to: oldTo, lines: pair.newLines.slice(head, newTo + 1) }]
}

function clusterGroups(groups: readonly LineGroup[]): LineGroup[][] {
  const clusters: LineGroup[][] = []

  for (const group of groups) {
    const current = clusters.at(-1)
    const previous = current?.at(-1)
    if (current === undefined || previous === undefined || group.from - previous.to - 1 > CONTEXT_LINES * 2) {
      clusters.push([group])
      continue
    }

    current.push(group)
  }

  return clusters
}

const context = (line: string): string => ` ${line}`
const removal = (line: string): string => `-${line}`
const addition = (line: string): string => `+${line}`

function renderHunk(args: { oldLines: readonly string[]; cluster: readonly LineGroup[]; delta: number }): string {
  const { oldLines, cluster, delta } = args
  const first = cluster[0]
  const last = cluster.at(-1)
  if (first === undefined || last === undefined) return ''

  const start = Math.max(0, first.from - CONTEXT_LINES)
  const end = Math.min(oldLines.length - 1, last.to + CONTEXT_LINES)
  const oldCount = end - start + 1
  const newCount = cluster.reduce(
    (total, group) => total + group.lines.length - (group.to - group.from + 1),
    oldCount,
  )
  const oldStart = oldCount === 0 ? start : start + 1
  const newStart = newCount === 0 ? start + delta : start + 1 + delta

  const body = oldLines.slice(start, first.from).map(context)
  for (const [index, group] of cluster.entries()) {
    body.push(...oldLines.slice(group.from, group.to + 1).map(removal))
    body.push(...group.lines.map(addition))
    const nextFrom = cluster[index + 1]?.from ?? end + 1
    body.push(...oldLines.slice(group.to + 1, nextFrom).map(context))
  }

  return [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body].join('\n')
}

export function renderUnifiedDiff(args: {
  path: string
  oldContent: string | null
  newContent: string
}): string {
  const newLines = splitLines(args.newContent)
  const oldLines = args.oldContent === null ? [] : splitLines(args.oldContent)
  const oldLabel = args.oldContent === null ? '/dev/null' : args.path
  const header = `--- ${oldLabel}\n+++ ${args.path}`

  const clusters = clusterGroups(changedGroups({ oldLines, newLines }))
  if (clusters.length === 0) return `${header}\n`

  const hunks: string[] = []
  let delta = 0
  for (const cluster of clusters) {
    hunks.push(renderHunk({ oldLines, cluster, delta }))
    delta = cluster.reduce((total, group) => total + group.lines.length - (group.to - group.from + 1), delta)
  }

  return `${header}\n${hunks.join('\n')}\n`
}
