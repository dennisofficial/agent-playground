import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

import type { FileSystemPort } from '@dltech/atlas-core'

import { LocalFileSystemPort } from '../execution/local-filesystem'

const DEFAULT_FILE_MODE = 0o644

const PERMISSION_BITS = 0o777

const temporaryBeside = (path: string): string =>
  join(dirname(path), `.${basename(path)}.${randomUUID()}.atlas-partial`)

export async function writeFileAtomically(args: {
  path: string
  content: string
  mode?: number | undefined
  files?: FileSystemPort | undefined
}): Promise<number> {
  const files = args.files ?? new LocalFileSystemPort()
  await files.mkdir({ path: dirname(args.path) })

  const temporary = temporaryBeside(args.path)
  const mode = args.mode === undefined ? DEFAULT_FILE_MODE : args.mode & PERMISSION_BITS

  try {
    await files.writeFile({ path: temporary, content: args.content, mode })
    await files.rename({ from: temporary, to: args.path })
  } catch (error) {
    await files.removeFile({ path: temporary }).catch(() => undefined)
    throw error
  }

  return Buffer.byteLength(args.content, 'utf8')
}
