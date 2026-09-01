import { normalisePath, resolveAgainst } from '../path-set'
import { cwdAfterSegment, cwdForSegment } from './cwd'
import { EExpansionKind } from './expansion'
import { splitArguments } from './flags'
import { lexCommand, type LexedToken } from './lex'
import { ESegmentJoin, splitSegments, type TokenSegment } from './segments'
import {
  destroysItsOperands,
  effectiveProgram,
  EReadConfidence,
  runsAnInlineScript,
  type BuiltSegment,
  type CommandReading,
  type CommandSegment,
} from './reading'
import {
  blockTerminators,
  interpreters,
  maximumScriptNesting,
  segmentIntroducers,
  shellKeywords,
} from './vocabulary'

export { EReadConfidence }
export type { CommandReading, CommandSegment }

const assignmentPattern = /^[A-Za-z_][A-Za-z0-9_]*=/
const uriPattern = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//

function harvestAssignments({
  segments,
}: {
  segments: readonly TokenSegment[]
}): Map<string, string> {
  const assignments = new Map<string, string>()

  for (const segment of segments) {
    for (const word of segment.words) {
      if (!assignmentPattern.test(word.text)) break
      if (word.expansions.length > 0) break
      const equals = word.text.indexOf('=')
      assignments.set(word.text.slice(0, equals), word.text.slice(equals + 1))
    }
  }

  return assignments
}

function expansionsOf({ tokens }: { tokens: readonly LexedToken[] }): readonly string[] {
  const seen = new Set<string>()

  for (const token of tokens) {
    for (const expansion of token.expansions) {
      seen.add(expansion.kind === EExpansionKind.Variable ? `$${expansion.text}` : expansion.text)
    }
  }

  return [...seen]
}

function resolveOperand({ token, cwd }: { token: LexedToken; cwd: string | undefined }): string {
  if (cwd === undefined) return token.text
  if (token.isHeredocBody) return token.text
  if (token.expansions.length > 0) return token.text
  if (token.text === '') return token.text
  if (token.text.startsWith('-')) return token.text
  if (uriPattern.test(token.text)) return token.text
  return resolveAgainst({ base: cwd, path: token.text })
}

function meaningfulWords({ words }: { words: readonly LexedToken[] }): readonly LexedToken[] {
  let start = 0

  while (start < words.length) {
    const word = words[start]
    if (word === undefined) break
    if (word.isHeredocBody) break
    if (!assignmentPattern.test(word.text) && !segmentIntroducers.has(word.text)) break
    start += 1
  }

  return words.slice(start)
}

function keywordSegment(args: {
  program: string
  words: readonly LexedToken[]
  incoming: string | undefined
  unresolvedExpansions: readonly string[]
  join: ESegmentJoin | undefined
}): BuiltSegment {
  return {
    segment: {
      program: args.program,
      verb: undefined,
      flags: [],
      operands: [],
      rawOperands: args.words.slice(1).map((word) => word.text),
      cwd: args.incoming,
      redirectsInto: [],
      pipesIntoInterpreter: false,
      unresolvedExpansions: args.unresolvedExpansions,
    },
    join: args.join,
    readable: false,
    unresolvedOperand: false,
  }
}

function buildSegment(args: {
  tokenSegment: TokenSegment
  incoming: string | undefined
}): BuiltSegment | undefined {
  const words = meaningfulWords({ words: args.tokenSegment.words })
  const head = words[0]
  if (head === undefined) return undefined
  if (blockTerminators.has(head.text)) return undefined

  const program = head.text
  const join = args.tokenSegment.joinToNext
  const unresolvedExpansions = expansionsOf({
    tokens: [...words, ...args.tokenSegment.redirectTargets],
  })

  if (shellKeywords.has(program)) {
    return keywordSegment({ program, words, incoming: args.incoming, unresolvedExpansions, join })
  }

  const split = splitArguments({ program, words: words.slice(1) })
  const cwd = cwdForSegment({ incoming: args.incoming, program, flagValues: split.flagValues })
  const unresolvedOperand = [...split.operands, ...args.tokenSegment.redirectTargets].some(
    (token) => token.expansions.length > 0,
  )

  const draft: CommandSegment = {
    program,
    verb: split.verb,
    flags: split.flags,
    operands: split.operands.map((token) => resolveOperand({ token, cwd })),
    rawOperands: split.operands.map((token) => token.text),
    cwd,
    redirectsInto: args.tokenSegment.redirectTargets.map((token) => resolveOperand({ token, cwd })),
    pipesIntoInterpreter: false,
    unresolvedExpansions,
  }

  return {
    segment: runsAnInlineScript({ segment: draft })
      ? { ...draft, operands: draft.rawOperands }
      : draft,
    join,
    readable: cwd !== undefined && unresolvedExpansions.length === 0,
    unresolvedOperand,
  }
}

function markInterpreterPipes({ built }: { built: readonly BuiltSegment[] }): void {
  built.forEach((entry, index) => {
    if (entry.join !== ESegmentJoin.Pipe) return
    const next = built[index + 1]
    if (next === undefined) return
    if (!interpreters.has(effectiveProgram({ segment: next.segment }))) return
    entry.segment = { ...entry.segment, pipesIntoInterpreter: true }
  })
}

type Pass = {
  built: readonly BuiltSegment[]
  unterminated: boolean
}

function readWithin(args: {
  command: string
  startingCwd: string | undefined
  projectDirectory: string
  depth: number
}): Pass {
  const survey = splitSegments({ tokens: lexCommand({ command: args.command }).tokens })
  const assignments = harvestAssignments({ segments: survey })

  const lexed = lexCommand({
    command: args.command,
    resolveVariable: (name) => assignments.get(name),
  })
  const tokenSegments = splitSegments({ tokens: lexed.tokens })

  const scopes: (string | undefined)[] = [args.startingCwd]
  const built: BuiltSegment[] = []
  let unterminated = lexed.unterminated

  for (const tokenSegment of tokenSegments) {
    while (scopes.length - 1 > tokenSegment.depth) scopes.pop()
    while (scopes.length - 1 < tokenSegment.depth) scopes.push(scopes[scopes.length - 1])

    const incoming = scopes[scopes.length - 1]
    const entry = buildSegment({ tokenSegment, incoming })

    if (entry !== undefined) {
      built.push(entry)
      const nested = inlineScriptOf({ entry, depth: args.depth })
      if (nested !== undefined) {
        const inner = readWithin({
          command: nested,
          startingCwd: entry.segment.cwd,
          projectDirectory: args.projectDirectory,
          depth: args.depth + 1,
        })
        for (const innerEntry of inner.built) built.push(innerEntry)
        unterminated = unterminated || inner.unterminated
      }
    }

    const words = meaningfulWords({ words: tokenSegment.words })
    const head = words[0]
    if (head === undefined) continue

    scopes[scopes.length - 1] = cwdAfterSegment({
      incoming,
      program: head.text,
      operands: words.slice(1).map((word) => word.text),
      operandsAreLiteral: words.slice(1).every((word) => word.expansions.length === 0),
    })
  }

  markInterpreterPipes({ built })
  return { built, unterminated }
}

function inlineScriptOf({
  entry,
  depth,
}: {
  entry: BuiltSegment
  depth: number
}): string | undefined {
  if (depth >= maximumScriptNesting) return undefined
  if (!runsAnInlineScript({ segment: entry.segment })) return undefined
  if (entry.unresolvedOperand) return undefined
  return entry.segment.rawOperands[0]
}

function decideConfidence({ built, unterminated }: Pass): EReadConfidence {
  if (unterminated) return EReadConfidence.Opaque
  if (built.some((entry) => entry.segment.program === 'eval')) return EReadConfidence.Opaque

  const unreadableDanger = built.some(
    (entry) =>
      entry.unresolvedOperand &&
      (destroysItsOperands({ segment: entry.segment }) ||
        runsAnInlineScript({ segment: entry.segment })),
  )
  if (unreadableDanger) return EReadConfidence.Opaque

  if (built.every((entry) => entry.readable)) return EReadConfidence.Read
  return EReadConfidence.Partial
}

export function readCommand(args: {
  command: string
  workdir: string | undefined
  projectDirectory: string
}): CommandReading {
  const project = normalisePath({ path: args.projectDirectory })
  const pass = readWithin({
    command: args.command,
    startingCwd:
      args.workdir === undefined ? project : resolveAgainst({ base: project, path: args.workdir }),
    projectDirectory: project,
    depth: 0,
  })

  return {
    confidence: decideConfidence(pass),
    segments: pass.built.map((entry) => entry.segment),
  }
}
