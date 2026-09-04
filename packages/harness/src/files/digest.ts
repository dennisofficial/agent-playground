import type { FileSystemPort } from '@dltech/atlas-core'

import { LocalFileSystemPort } from '../execution/local-filesystem'

export async function digestOf(args: {
  path: string
  files?: FileSystemPort | undefined
}): Promise<string | undefined> {
  const files = args.files ?? new LocalFileSystemPort()
  try {
    return Bun.hash.wyhash(await files.readBytes({ path: args.path })).toString(16)
  } catch {
    return undefined
  }
}
