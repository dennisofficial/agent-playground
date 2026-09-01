import { EDeed, EDeedRealm, type DeedTarget } from '../../deed'
import type { CommandSegment } from '../reading'
import { wrappers } from '../vocabulary'

export type DeedSketch = {
  action: EDeed
  targets: readonly DeedTarget[]
  summary: string
}

export type CommandWord = { raw: string; path: string }

export type CommandView = {
  program: string
  words: readonly CommandWord[]
  flags: ReadonlySet<string>
  cwd: string | undefined
  redirectsInto: readonly string[]
}

export type VerbTable = (args: { view: CommandView }) => DeedSketch | undefined

const assignmentPattern = /^[A-Za-z_][A-Za-z0-9_]*=/

const durationPattern = /^\d+(\.\d+)?[smhd]?$/

function namesAProgram({ word }: { word: CommandWord }): boolean {
  if (assignmentPattern.test(word.raw)) return false
  return !durationPattern.test(word.raw)
}

function wordsOf({ segment }: { segment: CommandSegment }): readonly CommandWord[] {
  const raws =
    segment.verb === undefined ? segment.rawOperands : [segment.verb, ...segment.rawOperands]
  const paths = segment.verb === undefined ? segment.operands : [segment.verb, ...segment.operands]

  return raws.map((raw, index) => ({ raw, path: paths[index] ?? raw }))
}

export function viewOf({ segment }: { segment: CommandSegment }): CommandView {
  let program = segment.program
  let words = wordsOf({ segment })

  while (wrappers.has(program)) {
    const next = words.findIndex((word) => namesAProgram({ word }))
    const head = words[next]
    if (head === undefined) break
    program = head.raw
    words = words.slice(next + 1)
  }

  return {
    program,
    words,
    flags: new Set(segment.flags),
    cwd: segment.cwd,
    redirectsInto: segment.redirectsInto,
  }
}

export function verbOf({ view }: { view: CommandView }): string | undefined {
  return view.words[0]?.raw
}

export function subverbOf({ view }: { view: CommandView }): string | undefined {
  return view.words[1]?.raw
}

export function anyFlag({ view, flags }: { view: CommandView; flags: readonly string[] }): boolean {
  return flags.some((flag) => view.flags.has(flag))
}

export function pathTargets({ words }: { words: readonly CommandWord[] }): readonly DeedTarget[] {
  return words.map((word) => ({ realm: EDeedRealm.Path, value: word.path }))
}

export function refTargets({ words }: { words: readonly CommandWord[] }): readonly DeedTarget[] {
  return words.map((word) => ({ realm: EDeedRealm.GitRef, value: word.raw }))
}

export function worktreeTarget({ view }: { view: CommandView }): DeedTarget {
  return { realm: EDeedRealm.GitWorktree, value: view.cwd ?? '.' }
}

export function sketch(args: {
  action: EDeed
  targets?: readonly DeedTarget[]
  summary: string
}): DeedSketch {
  return { action: args.action, targets: args.targets ?? [], summary: args.summary }
}

export function readOnly({ summary }: { summary: string }): DeedSketch {
  return sketch({ action: EDeed.ReadOnly, summary })
}

export function routine({ summary }: { summary: string }): DeedSketch {
  return sketch({ action: EDeed.Routine, summary })
}
