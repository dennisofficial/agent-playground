import { z } from 'zod'

export const absolutePathSchema = z.string().min(1)

export enum ELineEnding {
  Lf = 'lf',
  Crlf = 'crlf',
}

export function detectLineEnding(content: string): ELineEnding {
  let crlf = 0
  let lf = 0

  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== '\n') continue
    if (index > 0 && content[index - 1] === '\r') crlf += 1
    else lf += 1
  }

  return crlf > lf ? ELineEnding.Crlf : ELineEnding.Lf
}

export const toLf = (content: string): string => content.replaceAll('\r\n', '\n')

export function withLineEnding(args: { content: string; ending: ELineEnding }): string {
  if (args.ending === ELineEnding.Lf) return args.content
  return toLf(args.content).split('\n').join('\r\n')
}

export function splitLines(content: string): string[] {
  if (content === '') return []

  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()

  return lines
}

export const isNewlineTerminated = (content: string): boolean =>
  content === '' || content.endsWith('\n')

const PATTERN_METACHARACTERS = /[.*+?^${}()|[\]\\]/g

export function lineEndingAgnosticPattern(target: string): string {
  return toLf(target).replace(PATTERN_METACHARACTERS, '\\$&').replaceAll('\n', '\\r?\\n')
}

export function endingOfRegion(args: { region: string; fallback: ELineEnding }): ELineEnding {
  if (args.region.includes('\r\n')) return ELineEnding.Crlf
  if (args.region.includes('\n')) return ELineEnding.Lf

  return args.fallback
}
