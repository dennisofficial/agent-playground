import { digestOf } from './digest'
import type { FileView } from './read-state'

export type FileFacts = { mtimeMs: number; size: number }

export async function movedSince({
  view,
  stats,
  path,
}: {
  view: FileView
  stats: FileFacts
  path: string
}): Promise<boolean> {
  if (view.mtimeMs !== stats.mtimeMs) return true
  if (view.size !== stats.size) return true

  const now = await digestOf({ path })

  return now !== undefined && now !== view.digest
}
