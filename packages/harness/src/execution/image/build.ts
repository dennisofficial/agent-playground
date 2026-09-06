import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, readlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { ETarEntryKind, tarEntries, type TarEntry } from './tar'
import type { ImageSummary } from '../docker/engine-images'

export enum EBuildContext {
  Directory = 'directory',
  DockerfileOnly = 'dockerfile-only',
}

export type DockerfileBuild = {
  path: string
  context: EBuildContext
}

export type ImageBuilder = {
  listImages(args: { labels: Record<string, string> }): Promise<ImageSummary[]>
  buildImage(args: {
    tag: string
    labels: Record<string, string>
    contextTar: Uint8Array<ArrayBuffer>
  }): Promise<void>
}

export const CONTEXT_HASH_LABEL = 'atlas.context-hash'

const walk = async (args: { directory: string; relative: string }): Promise<TarEntry[]> => {
  const names = await readdir(join(args.directory, args.relative))
  const entries: TarEntry[] = []
  for (const name of names.sort()) {
    if (name === '.git') continue
    const relative = args.relative === '' ? name : `${args.relative}/${name}`
    const path = join(args.directory, relative)
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) {
      entries.push({ name: relative, kind: ETarEntryKind.Symlink, linkname: await readlink(path) })
      continue
    }
    if (stat.isDirectory()) {
      entries.push({ name: `${relative}/`, kind: ETarEntryKind.Directory, mode: stat.mode & 0o777 })
      entries.push(...(await walk({ directory: args.directory, relative })))
      continue
    }
    entries.push({
      name: relative,
      kind: ETarEntryKind.File,
      mode: stat.mode & 0o777,
      body: new Uint8Array(await readFile(path)),
    })
  }
  return entries
}

export async function contextEntries(args: { directory: string }): Promise<TarEntry[]> {
  return await walk({ directory: args.directory, relative: '' })
}

async function dockerfileEntries(args: { dockerfile: DockerfileBuild }): Promise<TarEntry[]> {
  if (args.dockerfile.context === EBuildContext.DockerfileOnly) {
    return [
      {
        name: 'Dockerfile',
        kind: ETarEntryKind.File,
        body: new Uint8Array(await readFile(args.dockerfile.path)),
      },
    ]
  }
  return await contextEntries({ directory: dirname(args.dockerfile.path) })
}

export function contextHash(args: { entries: readonly TarEntry[] }): string {
  const hash = createHash('sha256')
  for (const entry of args.entries) {
    hash.update(entry.name)
    hash.update('\0')
    hash.update(entry.kind ?? ETarEntryKind.File)
    hash.update('\0')
    hash.update(entry.linkname ?? '')
    hash.update('\0')
    hash.update(entry.body ?? new Uint8Array(0))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 12)
}

export async function dockerfileImageReference(args: { dockerfile: DockerfileBuild }): Promise<string> {
  const entries = await dockerfileEntries(args)
  return `atlas-dockerfile:${contextHash({ entries })}`
}

export async function ensureBuiltImage(args: {
  builder: ImageBuilder
  dockerfile: DockerfileBuild
}): Promise<string> {
  const entries = await dockerfileEntries(args)
  const hash = contextHash({ entries })
  const tag = `atlas-dockerfile:${hash}`

  const existing = await args.builder.listImages({ labels: { [CONTEXT_HASH_LABEL]: hash } })
  if (existing.length > 0) return tag

  await args.builder.buildImage({
    tag,
    labels: { [CONTEXT_HASH_LABEL]: hash },
    contextTar: tarEntries({ entries }),
  })
  return tag
}
