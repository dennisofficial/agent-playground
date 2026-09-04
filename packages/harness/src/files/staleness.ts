import type { FileSystemPort } from '@dltech/atlas-core'

import { digestOf } from './digest'
import type { FileView } from './read-state'

export type FileFacts = { mtimeMs: number; size: number }

export async function movedSince({
  view,
  stats,
  path,
  files,
}: {
  view: FileView
  stats: FileFacts
  path: string
  files?: FileSystemPort | undefined
}): Promise<boolean> {
  if (view.mtimeMs !== stats.mtimeMs) return true
  if (view.size !== stats.size) return true

  const now = await digestOf({ path, files })

  return now !== undefined && now !== view.digest
}
