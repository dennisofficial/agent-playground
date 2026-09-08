import type { FileSystemPort, ThreadId } from '@dltech/atlas-core'

import { LocalFileSystemPort } from '../execution/local-filesystem'
import { digestOf } from './digest'
import type { FileReadStatePort } from './read-state'

export type InjectedFile = { path: string; wholeFile: boolean }

export async function recordLoadedFiles(args: {
  readState: FileReadStatePort
  threadId: ThreadId
  loaded: readonly InjectedFile[]
  files?: FileSystemPort | undefined
}): Promise<void> {
  if (args.loaded.length === 0) return

  const files = args.files ?? new LocalFileSystemPort()
  for (const { path, wholeFile } of args.loaded) {
    const stats = await files.stat({ path }).catch(() => undefined)
    if (stats === undefined || !stats.isFile()) continue

    const digest = await digestOf({ path, files })
    if (digest === undefined) continue

    args.readState.record({
      threadId: args.threadId,
      path,
      view: { mtimeMs: stats.mtimeMs, size: stats.size, wholeFile, digest },
    })
  }
}
