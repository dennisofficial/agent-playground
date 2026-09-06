import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { contextEntries, contextHash, dockerfileImageReference, EBuildContext, ensureBuiltImage, type ImageBuilder } from '../build'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-build-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const seed = async (files: Record<string, string>): Promise<void> => {
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content)
  }
}

describe('contextEntries', () => {
  it('collects files sorted by their relative posix name, skipping .git', async () => {
    await seed({
      'Dockerfile': 'FROM scratch\n',
      'nested/b.txt': 'b',
      'a.txt': 'a',
      '.git/HEAD': 'ref: refs/heads/main\n',
    })

    const entries = await contextEntries({ directory: root })

    expect(entries.map((entry) => entry.name)).toEqual([
      'Dockerfile',
      'a.txt',
      'nested/',
      'nested/b.txt',
    ])
  })
})

describe('contextHash', () => {
  it('is stable for identical content and moves with any byte or name', async () => {
    await seed({ 'Dockerfile': 'FROM scratch\n', 'a.txt': 'a' })
    const first = contextHash({ entries: await contextEntries({ directory: root }) })
    const again = contextHash({ entries: await contextEntries({ directory: root }) })
    expect(first).toBe(again)
    expect(first).toMatch(/^[0-9a-f]{12}$/)

    await seed({ 'a.txt': 'changed' })
    expect(contextHash({ entries: await contextEntries({ directory: root }) })).not.toBe(first)

    await seed({ 'a.txt': 'a', 'renamed.txt': 'a' })
    await rm(join(root, 'a.txt'))
    expect(contextHash({ entries: await contextEntries({ directory: root }) })).not.toBe(first)
  })
})

const fakeBuilder = (args: {
  existing?: readonly { id: string; labels: Record<string, string> }[]
}): { builder: ImageBuilder; builds: { tag: string; contextTar: Uint8Array }[] } => {
  const builds: { tag: string; contextTar: Uint8Array }[] = []
  return {
    builds,
    builder: {
      listImages: async () => [...(args.existing ?? [])],
      buildImage: async (build) => {
        builds.push({ tag: build.tag, contextTar: build.contextTar })
      },
    },
  }
}

describe('ensureBuiltImage', () => {
  it('reuses an image whose context-hash label matches, without building', async () => {
    await seed({ 'Dockerfile': 'FROM scratch\n' })
    const dockerfile = join(root, 'Dockerfile')
    const hash = contextHash({ entries: await contextEntries({ directory: root }) })
    const { builder, builds } = fakeBuilder({
      existing: [{ id: 'sha256:existing', labels: { 'atlas.context-hash': hash } }],
    })

    const reference = await ensureBuiltImage({
      builder,
      dockerfile: { path: dockerfile, context: EBuildContext.Directory },
    })

    expect(reference).toBe(`atlas-dockerfile:${hash}`)
    expect(builds).toHaveLength(0)
  })

  it('builds on a hash miss, tagging and labelling the build with the hash', async () => {
    await seed({ 'Dockerfile': 'FROM scratch\nCOPY a.txt /a.txt\n', 'a.txt': 'a' })
    const { builder, builds } = fakeBuilder({})

    const reference = await ensureBuiltImage({
      builder,
      dockerfile: { path: join(root, 'Dockerfile'), context: EBuildContext.Directory },
    })

    const hash = contextHash({ entries: await contextEntries({ directory: root }) })
    expect(reference).toBe(`atlas-dockerfile:${hash}`)
    expect(builds).toHaveLength(1)
    expect(builds[0]?.tag).toBe(reference)
    const tar = builds[0]?.contextTar ?? new Uint8Array(0)
    expect(new TextDecoder().decode(tar.subarray(257, 262))).toBe('ustar')
  })

  it('lets a build failure surface rather than returning a reference that does not exist', async () => {
    await seed({ 'Dockerfile': 'FROM scratch\n' })
    const builder: ImageBuilder = {
      listImages: async () => [],
      buildImage: async () => {
        throw new Error('the daemon rejected the context')
      },
    }

    await expect(
      ensureBuiltImage({
        builder,
        dockerfile: { path: join(root, 'Dockerfile'), context: EBuildContext.Directory },
      }),
    ).rejects.toThrow('the daemon rejected the context')
  })

  it('a Dockerfile-only context ships just the Dockerfile, never its neighbours', async () => {
    await seed({
      'Dockerfile': 'FROM ghcr.io/example/atlas-sandbox:1.0.0\n',
      'auth.json': '{"token":"secret"}',
      'harness.db': 'the event log',
    })
    const { builder, builds } = fakeBuilder({})

    await ensureBuiltImage({
      builder,
      dockerfile: { path: join(root, 'Dockerfile'), context: EBuildContext.DockerfileOnly },
    })

    const tar = builds[0]?.contextTar ?? new Uint8Array(0)
    const text = new TextDecoder().decode(tar)
    expect(text).toContain('Dockerfile')
    expect(text).not.toContain('auth.json')
    expect(text).not.toContain('secret')
    expect(text).not.toContain('harness.db')

    await seed({ 'auth.json': '{"token":"rotated"}' })
    const after = await dockerfileImageReference({
      dockerfile: { path: join(root, 'Dockerfile'), context: EBuildContext.DockerfileOnly },
    })
    const first = builds[0]
    if (first === undefined) throw new Error('no build was recorded')
    expect(after).toBe(first.tag)
  })
})
