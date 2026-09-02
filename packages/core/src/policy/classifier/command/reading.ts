import type { ESegmentJoin } from './segments'
import { interpreters, programsThatDestroyTheirOperands, scriptFlag, wrappers } from './vocabulary'

export enum EReadConfidence {
  Read = 'read',
  Partial = 'partial',
  Opaque = 'opaque',
}

export type CommandSegment = {
  program: string
  verb: string | undefined
  flags: readonly string[]
  operands: readonly string[]
  rawOperands: readonly string[]
  cwd: string | undefined
  redirectsInto: readonly string[]
  pipesIntoInterpreter: boolean
  unresolvedExpansions: readonly string[]
}

export type CommandReading = {
  confidence: EReadConfidence
  segments: readonly CommandSegment[]
  command: string
}

export type BuiltSegment = {
  segment: CommandSegment
  join: ESegmentJoin | undefined
  readable: boolean
  unresolvedOperand: boolean
}

export function effectiveProgram({ segment }: { segment: CommandSegment }): string {
  if (!wrappers.has(segment.program)) return segment.program
  return segment.verb ?? segment.program
}

export function destroysItsOperands({ segment }: { segment: CommandSegment }): boolean {
  if (programsThatDestroyTheirOperands.has(segment.program)) return true
  return programsThatDestroyTheirOperands.has(effectiveProgram({ segment }))
}

export function runsAnInlineScript({ segment }: { segment: CommandSegment }): boolean {
  if (!interpreters.has(effectiveProgram({ segment }))) return false
  return segment.flags.includes(scriptFlag)
}
