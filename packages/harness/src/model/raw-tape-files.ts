import { randomBytes } from 'node:crypto'
import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const TAPE_EXTENSION = '.jsonl'

const UNSAFE_IN_A_NAME = /[^A-Za-z0-9_-]+/g
const SCOPE_LENGTH = 48
const SEGMENT_DIGITS = 3

const sortableStamp = (at: Date): string => at.toISOString().replace(/[:.]/g, '-')

const safeScope = (scope: string): string => {
  const cleaned = scope.replace(UNSAFE_IN_A_NAME, '-').slice(0, SCOPE_LENGTH)
  return cleaned.length > 0 ? cleaned : 'unscoped'
}

export function tapePrefix(args: { scope: string; at: Date }): string {
  return `${sortableStamp(args.at)}-${safeScope(args.scope)}-${randomBytes(3).toString('hex')}`
}

export function tapeSegmentName(args: { prefix: string; segment: number }): string {
  return `${args.prefix}-${String(args.segment).padStart(SEGMENT_DIGITS, '0')}${TAPE_EXTENSION}`
}

type WeighedTape = { name: string; bytes: number }

async function weighTapes(directory: string): Promise<readonly WeighedTape[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(TAPE_EXTENSION)).sort()
  const weighed: WeighedTape[] = []

  for (const name of names) {
    const found = await stat(join(directory, name)).catch(() => undefined)
    if (found !== undefined) weighed.push({ name, bytes: found.size })
  }

  return weighed
}

export async function pruneTapes(args: {
  directory: string
  maximumFiles: number
  maximumBytes: number
  reserveBytes: number
}): Promise<void> {
  try {
    const weighed = await weighTapes(args.directory)
    let remaining = weighed.length
    let bytes = weighed.reduce((total, tape) => total + tape.bytes, 0)

    for (const tape of weighed) {
      const roomForOneMore =
        remaining < args.maximumFiles && bytes + args.reserveBytes <= args.maximumBytes
      if (roomForOneMore) return

      await unlink(join(args.directory, tape.name)).catch(() => {})
      remaining -= 1
      bytes -= tape.bytes
    }
  } catch {
    return
  }
}
