import { describe, expect, it } from 'bun:test'

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EMountMode, mountBind } from '../mounts'
import { EBuildContext } from '../build'
import { EConfigRefusal } from '../refusals'
import {
  EConfigSource,
  EImageKind,
  resolveContainerConfig,
  type ContainerResolution,
  type TextFileReader,
} from '../resolve'

const DIR = '/project'

const readerOf = (files: Record<string, string>): TextFileReader => {
  return async (path) => files[path]
}

const resolveWith = (files: Record<string, string>): Promise<ContainerResolution> =>
  resolveContainerConfig({ projectDirectory: DIR, readText: readerOf(files) })

describe('resolveContainerConfig precedence', () => {
  it('lets container.json win over devcontainer.json', async () => {
    const resolution = await resolveWith({
      [`${DIR}/.atlas/container.json`]: JSON.stringify({ image: 'repo/toolchain:latest' }),
      [`${DIR}/.devcontainer/devcontainer.json`]: JSON.stringify({ image: 'devcontainer/image' }),
    })

    expect(resolution.source).toBe(EConfigSource.ContainerJson)
    expect(resolution.image).toEqual({ kind: EImageKind.Image, reference: 'repo/toolchain:latest' })
  })

  it('lets devcontainer.json win over the built-in default', async () => {
    const resolution = await resolveWith({
      [`${DIR}/.devcontainer/devcontainer.json`]: JSON.stringify({
        image: 'devcontainer/image',
        postCreateCommand: 'bun install',
        features: {},
      }),
    })

    expect(resolution.source).toBe(EConfigSource.DevcontainerJson)
    expect(resolution.image).toEqual({ kind: EImageKind.Image, reference: 'devcontainer/image' })
    expect(resolution.setup).toBe('bun install')
    expect(resolution.notes.some((note) => note.includes('features'))).toBe(true)
  })

  it('falls through to devcontainer.json when container.json is malformed, carrying the refusal', async () => {
    const resolution = await resolveWith({
      [`${DIR}/.atlas/container.json`]: '{ broken',
      [`${DIR}/.devcontainer/devcontainer.json`]: JSON.stringify({ image: 'devcontainer/image' }),
    })

    expect(resolution.source).toBe(EConfigSource.DevcontainerJson)
    expect(resolution.refusals).toHaveLength(1)
    expect(resolution.refusals[0]?.refusal).toBe(EConfigRefusal.NotJson)
    expect(resolution.refusals[0]?.file).toBe(`${DIR}/.atlas/container.json`)
  })

  it('takes .atlas/Dockerfile only when nothing names an image, and says it is the escape hatch', async () => {
    const resolution = await resolveWith({
      [`${DIR}/.atlas/Dockerfile`]: 'FROM node:22-slim\n',
    })

    expect(resolution.source).toBe(EConfigSource.Dockerfile)
    expect(resolution.image).toEqual({
      kind: EImageKind.Dockerfile,
      path: `${DIR}/.atlas/Dockerfile`,
      context: EBuildContext.Directory,
    })
    expect(resolution.notes.some((note) => note.includes('escape hatch'))).toBe(true)
    expect(resolution.notes.some((note) => note.includes('container.json'))).toBe(true)
  })

  it('falls back to a user-level Dockerfile in the atlas home, after the project-level one', async () => {
    const user = await resolveContainerConfig({
      projectDirectory: DIR,
      atlasHome: '/operator/.atlas',
      readText: readerOf({ '/operator/.atlas/Dockerfile': 'FROM ghcr.io/example/atlas-sandbox:1.0.0\n' }),
    })

    expect(user.source).toBe(EConfigSource.Dockerfile)
    expect(user.image).toEqual({
      kind: EImageKind.Dockerfile,
      path: '/operator/.atlas/Dockerfile',
      context: EBuildContext.DockerfileOnly,
    })

    const project = await resolveContainerConfig({
      projectDirectory: DIR,
      atlasHome: '/operator/.atlas',
      readText: readerOf({
        '/operator/.atlas/Dockerfile': 'FROM ghcr.io/example/atlas-sandbox:1.0.0\n',
        [`${DIR}/.atlas/Dockerfile`]: 'FROM ghcr.io/example/atlas-sandbox:1.0.0\nRUN apt-get update\n',
      }),
    })

    expect(project.image).toEqual({
      kind: EImageKind.Dockerfile,
      path: `${DIR}/.atlas/Dockerfile`,
      context: EBuildContext.Directory,
    })
  })

  it('answers the built-in default in silence when nothing is configured', async () => {
    const resolution = await resolveWith({})

    expect(resolution.source).toBe(EConfigSource.BuiltIn)
    expect(resolution.image).toEqual({
      kind: EImageKind.Image,
      reference: 'ghcr.io/dennisofficial/atlas-sandbox:latest',
    })
    expect(resolution.setup).toBeUndefined()
    expect(resolution.notes).toEqual([])
    expect(resolution.refusals).toEqual([])
    expect(resolution.mounts).toEqual([])
  })

  it('needs no setup when container.json names no image, because the default image bakes the toolchain', async () => {
    const resolution = await resolveWith({
      [`${DIR}/.atlas/container.json`]: JSON.stringify({
        mounts: [{ path: '/Users/operator/Developer/shared-lib' }],
      }),
    })

    expect(resolution.source).toBe(EConfigSource.ContainerJson)
    expect(resolution.image).toEqual({
      kind: EImageKind.Image,
      reference: 'ghcr.io/dennisofficial/atlas-sandbox:latest',
    })
    expect(resolution.setup).toBeUndefined()
    expect(resolution.mounts).toEqual([
      { path: '/Users/operator/Developer/shared-lib', mode: EMountMode.ReadOnly },
    ])
  })

  it('drops the default setup once the operator names an image', async () => {
    const resolution = await resolveWith({
      [`${DIR}/.atlas/container.json`]: JSON.stringify({ image: 'repo/toolchain:latest' }),
    })

    expect(resolution.setup).toBeUndefined()
  })

  it('resolves a field set sufficient for both the Docker create body and Vercel Sandbox.create', async () => {
    const resolution = await resolveWith({
      [`${DIR}/.atlas/container.json`]: JSON.stringify({
        image: 'repo/toolchain:latest',
        setup: 'bun install',
        start: 'docker compose up -d',
        mounts: [{ path: '/Users/operator/Developer/shared-lib' }],
      }),
    })

    if (resolution.image.kind !== EImageKind.Image) throw new Error('expected an image reference')

    const docker = {
      image: resolution.image.reference,
      setup: resolution.setup,
      start: resolution.start,
      binds: resolution.mounts.map(mountBind),
    }
    const vercel = {
      image: resolution.image.reference,
      onCreate: resolution.setup,
      onResume: resolution.start,
    }

    expect(docker).toEqual({
      image: 'repo/toolchain:latest',
      setup: 'bun install',
      start: 'docker compose up -d',
      binds: ['/Users/operator/Developer/shared-lib:/Users/operator/Developer/shared-lib:ro'],
    })
    expect(vercel).toEqual({
      image: 'repo/toolchain:latest',
      onCreate: 'bun install',
      onResume: 'docker compose up -d',
    })
  })

  it('reads real files from the project directory when no reader is injected', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-dev-resolve-'))
    try {
      await mkdir(join(directory, '.atlas'), { recursive: true })
      await writeFile(
        join(directory, '.atlas', 'container.json'),
        JSON.stringify({ image: 'repo/real:latest' }),
      )

      const resolution = await resolveContainerConfig({ projectDirectory: directory })

      expect(resolution.source).toBe(EConfigSource.ContainerJson)
      expect(resolution.image).toEqual({ kind: EImageKind.Image, reference: 'repo/real:latest' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
