import { stat } from 'node:fs/promises'

import { EToolEffect, type ToolDefinition } from '@dltech/atlas-core'
import { z } from 'zod'

import { absolutePathSchema } from './file-text'

const MAX_READ_BYTES = 262_144

const BINARY_SNIFF_LENGTH = 4096

const NUL = '\u0000'

const inputSchema = z.strictObject({
  path: absolutePathSchema,
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).optional(),
})

const description = [
  'Read a text file from the filesystem.',
  'The path must be absolute.',
  'Output is line-numbered, tab-separated, one line per file line.',
  'Use offset to start at a given 1-based line and limit to cap how many lines come back.',
  `A read is refused when the lines it returns exceed ${MAX_READ_BYTES} bytes;`,
  'narrow it with offset and limit, or use grep to locate what you need.',
].join(' ')

enum EScan {
  Selected = 'selected',
  PastEnd = 'past-end',
  Overflow = 'overflow',
}

type LineScan =
  | { kind: EScan.Selected; lines: string[]; moreAfter: boolean }
  | { kind: EScan.PastEnd; totalLines: number }
  | { kind: EScan.Overflow; atLine: number }

const withoutCarriageReturn = (line: string): string =>
  line.endsWith('\r') ? line.slice(0, -1) : line

async function* linesOf(path: string): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let pending = ''

  for await (const chunk of Bun.file(path).stream()) {
    pending += decoder.decode(chunk, { stream: true })

    let start = 0
    let newline = pending.indexOf('\n', start)
    while (newline !== -1) {
      yield withoutCarriageReturn(pending.slice(start, newline))
      start = newline + 1
      newline = pending.indexOf('\n', start)
    }
    pending = pending.slice(start)
  }

  pending += decoder.decode()
  if (pending !== '') yield withoutCarriageReturn(pending)
}

async function scanLines(args: {
  path: string
  firstLine: number
  limit: number | undefined
}): Promise<LineScan> {
  const lines: string[] = []
  let lineNumber = 0
  let bytes = 0

  for await (const line of linesOf(args.path)) {
    lineNumber += 1
    if (lineNumber < args.firstLine) continue

    if (args.limit !== undefined && lines.length >= args.limit) {
      return { kind: EScan.Selected, lines, moreAfter: true }
    }

    bytes += Buffer.byteLength(line, 'utf8') + 1
    if (bytes > MAX_READ_BYTES) return { kind: EScan.Overflow, atLine: lineNumber }

    lines.push(line)
  }

  if (lines.length === 0) return { kind: EScan.PastEnd, totalLines: lineNumber }

  return { kind: EScan.Selected, lines, moreAfter: false }
}

export function createReadTool(): ToolDefinition {
  return {
    name: 'read',
    description,
    effect: EToolEffect.Read,
    inputSchema,
    async invoke({ input }) {
      const parsed = inputSchema.safeParse(input)
      if (!parsed.success) return { ok: false, reason: `read received invalid input: ${parsed.error.message}` }

      const { path, offset, limit } = parsed.data
      const stats = await stat(path).catch(() => null)
      if (stats === null) return { ok: false, reason: `File does not exist: ${path}` }
      if (stats.isDirectory()) {
        return { ok: false, reason: `${path} is a directory; use glob or grep to inspect its contents.` }
      }
      if (!stats.isFile()) return { ok: false, reason: `${path} is not a regular file.` }

      const opening = await Bun.file(path).slice(0, BINARY_SNIFF_LENGTH).text()
      if (opening.includes(NUL)) {
        return { ok: false, reason: `${path} looks like a binary file and cannot be read as text.` }
      }

      const firstLine = offset ?? 1
      const scan = await scanLines({ path, firstLine, limit })

      if (scan.kind === EScan.Overflow) {
        return {
          ok: false,
          reason: `reading ${path} from line ${firstLine} passes the ${MAX_READ_BYTES} byte read limit at line ${scan.atLine}. Narrow the range with offset and limit, or use grep to find the part you need.`,
        }
      }

      if (scan.kind === EScan.PastEnd) {
        return {
          ok: true,
          output: { path, lines: 0, truncated: scan.totalLines > 0 },
          modelText:
            scan.totalLines === 0
              ? `${path} exists but is empty.`
              : `${path} has ${scan.totalLines} lines; line ${firstLine} is past the end of the file.`,
        }
      }

      return {
        ok: true,
        output: { path, lines: scan.lines.length, truncated: firstLine > 1 || scan.moreAfter },
        modelText: scan.lines.map((line, index) => `${firstLine + index}\t${line}`).join('\n'),
      }
    },
  }
}
