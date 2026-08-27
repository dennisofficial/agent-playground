import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { atlasTapesDirectory } from '../store/paths'
import { pruneTapes, tapePrefix, tapeSegmentName } from './raw-tape-files'
import { closedLine, rotatedLine, toTapeLine } from './raw-tape-line'

export const RAW_TAPE_ENVIRONMENT_VARIABLE = 'ATLAS_RAW_TAPE'

const OPT_INS = new Set(['1', 'true', 'yes', 'on'])

const FLUSH_AT_BYTES = 16 * 1024
const FLUSH_AFTER_MS = 250
const SEGMENT_BYTES = 8 * 1024 * 1024
const MAXIMUM_TAPE_FILES = 32
const MAXIMUM_DIRECTORY_BYTES = 128 * 1024 * 1024

export type RawTape = {
  tap: (part: unknown) => void
  close: () => Promise<void>
}

export const NO_RAW_TAPE: RawTape = {
  tap: () => {},
  close: async () => {},
}

export function rawTapeEnabled(args: {
  env: Readonly<Record<string, string | undefined>>
}): boolean {
  const value = args.env[RAW_TAPE_ENVIRONMENT_VARIABLE]
  return value !== undefined && OPT_INS.has(value.trim().toLowerCase())
}

export function createRawTape(args: {
  scope: string
  env?: Readonly<Record<string, string | undefined>>
  directory?: string
  segmentBytes?: number
  maximumFiles?: number
  maximumDirectoryBytes?: number
}): RawTape {
  if (!rawTapeEnabled({ env: args.env ?? process.env })) return NO_RAW_TAPE

  const directory = args.directory ?? atlasTapesDirectory()
  const prefix = tapePrefix({ scope: args.scope, at: new Date() })
  const segmentBytes = args.segmentBytes ?? SEGMENT_BYTES
  const maximumFiles = args.maximumFiles ?? MAXIMUM_TAPE_FILES
  const maximumBytes = args.maximumDirectoryBytes ?? MAXIMUM_DIRECTORY_BYTES

  let segment = 0
  let file = join(directory, tapeSegmentName({ prefix, segment }))
  let pending: string[] = []
  let pendingBytes = 0
  let segmentUsed = 0
  let everTapped = false
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let writes: Promise<void> = Promise.resolve()

  const openedSegments = new Set<string>()

  const openSegment = async (): Promise<void> => {
    await mkdir(directory, { recursive: true })
    await pruneTapes({ directory, maximumFiles, maximumBytes, reserveBytes: segmentBytes })
  }

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (pending.length === 0) return

    const payload = pending.join('')
    const target = file
    const opening = !openedSegments.has(target)
    openedSegments.add(target)
    pending = []
    pendingBytes = 0

    writes = writes
      .then(() => (opening ? openSegment() : undefined))
      .then(() => appendFile(target, payload))
      .catch(() => {})
  }

  const scheduleFlush = (): void => {
    if (timer !== undefined) return
    timer = setTimeout(flush, FLUSH_AFTER_MS)
    timer.unref()
  }

  const buffer = (line: string): void => {
    pending.push(line)
    const size = Buffer.byteLength(line)
    pendingBytes += size
    segmentUsed += size
  }

  const rotate = (): void => {
    const next = tapeSegmentName({ prefix, segment: segment + 1 })
    buffer(`${rotatedLine(next)}\n`)
    flush()

    segment += 1
    file = join(directory, next)
    segmentUsed = 0
  }

  return {
    tap: (part) => {
      if (closed) return

      const line = `${toTapeLine(part)}\n`
      if (everTapped && segmentUsed + Buffer.byteLength(line) > segmentBytes) rotate()
      everTapped = true

      buffer(line)
      if (pendingBytes >= FLUSH_AT_BYTES) {
        flush()
        return
      }
      scheduleFlush()
    },

    close: async () => {
      if (closed) {
        await writes
        return
      }

      closed = true
      if (everTapped) buffer(`${closedLine()}\n`)
      flush()
      await writes
    },
  }
}
