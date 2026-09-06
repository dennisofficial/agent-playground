import { describe, expect, it } from 'bun:test'

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ETarEntryKind, tarEntries } from '../tar'

const roundTrip = async (args: {
  entries: readonly { name: string; body: Uint8Array }[]
}): Promise<Map<string, string>> => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-tar-'))
  try {
    const archive = join(directory, 'context.tar')
    await writeFile(archive, tarEntries({ entries: args.entries }))
    const listing = Bun.spawnSync(['tar', '-tf', archive])
    expect(listing.exitCode).toBe(0)
    const extracted = new Map<string, string>()
    for (const name of new TextDecoder().decode(listing.stdout).trim().split('\n')) {
      const content = Bun.spawnSync(['tar', '-xOf', archive, name])
      expect(content.exitCode).toBe(0)
      extracted.set(name, new TextDecoder().decode(content.stdout))
    }
    return extracted
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('tarEntries', () => {
  it('writes an archive the system tar reads back byte for byte', async () => {
    const extracted = await roundTrip({
      entries: [
        { name: 'Dockerfile', body: new TextEncoder().encode('FROM scratch\n') },
        { name: 'nested/dir/file.txt', body: new TextEncoder().encode('nested content\n') },
        { name: 'empty', body: new Uint8Array(0) },
      ],
    })

    expect(extracted.get('Dockerfile')).toBe('FROM scratch\n')
    expect(extracted.get('nested/dir/file.txt')).toBe('nested content\n')
    expect(extracted.get('empty')).toBe('')
  })

  it('is deterministic: the same entries pack to identical bytes', () => {
    const entries = [
      { name: 'b.txt', body: new TextEncoder().encode('two') },
      { name: 'a.txt', body: new TextEncoder().encode('one') },
    ]

    expect(tarEntries({ entries })).toEqual(tarEntries({ entries: [...entries] }))
  })

  it('spans long names across the ustar prefix field', async () => {
    const name = `deep/${'segment/'.repeat(20)}leaf.txt`
    const extracted = await roundTrip({
      entries: [{ name, body: new TextEncoder().encode('deep') }],
    })

    expect(extracted.get(name)).toBe('deep')
  })

  it('refuses a name no ustar header can hold', () => {
    const name = `${'x'.repeat(200)}.txt`
    expect(() =>
      tarEntries({ entries: [{ name, body: new Uint8Array(0) }] }),
    ).toThrow(/too long/)
  })

  it('carries directories, symlinks and executable modes, not just files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-tar-kinds-'))
    try {
      const archive = join(directory, 'context.tar')
      await writeFile(archive, tarEntries({
        entries: [
          { name: 'bin/', kind: ETarEntryKind.Directory, mode: 0o755 },
          { name: 'bin/run.sh', kind: ETarEntryKind.File, mode: 0o755, body: new TextEncoder().encode('#!/bin/sh\n') },
          { name: 'latest', kind: ETarEntryKind.Symlink, linkname: 'bin/run.sh' },
        ],
      }))

      const listing = Bun.spawnSync(['tar', '-tvf', archive])
      expect(listing.exitCode).toBe(0)
      const lines = new TextDecoder().decode(listing.stdout).trim().split('\n')
      const byName = new Map(lines.map((line) => [line.split(/\s+/).at(-1) ?? '', line]))
      expect(byName.get('bin/')?.startsWith('d')).toBe(true)
      expect(byName.get('bin/run.sh')?.startsWith('-rwxr-xr-x')).toBe(true)
      expect(byName.get('latest')?.startsWith('l')).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
