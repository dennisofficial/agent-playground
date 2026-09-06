import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join } from 'node:path'

import type { FileSystemPort } from '@dltech/atlas-core'

import { LocalFileSystemPort } from '../execution/local-filesystem'

const DEFAULT_FILE_MODE = 0o644

const PERMISSION_BITS = 0o777

const temporaryBeside = (path: string): string =>
  join(dirname(path), `.${basename(path)}.${randomUUID()}.atlas-partial`)

const MAX_LINK_HOPS = 40

async function resolveLinkChain(args: { path: string; files: FileSystemPort }): Promise<string> {
  let current = args.path
  for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
    const target = await args.files.readLink({ path: current })
    if (target === null) return current
    current = isAbsolute(target) ? target : join(dirname(current), target)
  }
  throw new Error(`Cannot write ${args.path}: too many levels of symbolic links`)
}

export async function writeFileAtomically(args: {
  path: string
  content: string
  mode?: number | undefined
  files?: FileSystemPort | undefined
}): Promise<number> {
  const files = args.files ?? new LocalFileSystemPort()
  const path = await resolveLinkChain({ path: args.path, files })
  await files.mkdir({ path: dirname(path) })

  const temporary = temporaryBeside(path)
  const mode = args.mode === undefined ? DEFAULT_FILE_MODE : args.mode & PERMISSION_BITS

  try {
    await files.writeFile({ path: temporary, content: args.content, mode })
    await files.rename({ from: temporary, to: path })
  } catch (error) {
    await files.removeFile({ path: temporary }).catch(() => undefined)
    throw error
  }

  return Buffer.byteLength(args.content, 'utf8')
}
