import { describe, expect, it } from 'bun:test'

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EMountMode, mountBind } from '../mounts'
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

async function runDefaultSetup(args: { curl: string; bun?: string; aptGet?: string }) {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-default-setup-'))
  try {
    const commands = {
      'apt-get': args.aptGet ?? 'exit 0',
      curl: args.curl,
      bun: args.bun ?? 'printf "bun %s\\n" "$*"',
      npx: 'printf "npx %s\\n" "$*"',
    }
    await Promise.all(
      Object.entries(commands).map(([name, script]) =>
        writeFile(join(directory, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 }),
      ),
    )
    const { setup } = await resolveWith({})
    if (setup === undefined) throw new Error('expected default setup')
    const child = Bun.spawn(['sh', '-c', setup], {
      cwd: directory,
      env: { HOME: directory, PATH: `${directory}:/usr/bin:/bin` },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { exitCode, stdout, stderr }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

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
    })
    expect(resolution.notes.some((note) => note.includes('escape hatch'))).toBe(true)
    expect(resolution.notes.some((note) => note.includes('container.json'))).toBe(true)
  })

  it('answers the built-in default in silence when nothing is configured', async () => {
    const resolution = await resolveWith({})

    expect(resolution.source).toBe(EConfigSource.BuiltIn)
    expect(resolution.image).toEqual({ kind: EImageKind.Image, reference: 'node:22-trixie-slim' })
    expect(resolution.notes).toEqual([])
    expect(resolution.refusals).toEqual([])
    expect(resolution.mounts).toEqual([])
  })

  it('makes the default toolchain self-sufficient: git, ripgrep and the Playwright system deps', async () => {
    const resolution = await resolveWith({})

    expect(resolution.setup).toContain('git')
    expect(resolution.setup).toContain('ripgrep')
    expect(resolution.setup).toContain('playwright')
  })

  it('installs an ssh client so network git works over the forwarded agent', async () => {
    const resolution = await resolveWith({})

    expect(resolution.setup).toContain('openssh-client')
  })

  it('installs bun with curl, since the workspace runs on it', async () => {
    const resolution = await resolveWith({})

    expect(resolution.setup).toContain('curl')
    expect(resolution.setup).toContain('unzip')
    expect(resolution.setup).toContain('bun.sh/install')
  })

  it.each(['exit 22', 'printf "exit 0\\n"; exit 22'])(
    'fails setup on a failed or partial installer download: %s',
    async (curl) => {
      const result = await runDefaultSetup({ curl })

      expect(result.exitCode).toBe(22)
      expect(result.stdout).not.toContain('bun')
      expect(result.stdout).not.toContain('npx')
    },
  )

  it('rejects setup when bun cannot run from PATH', async () => {
    const result = await runDefaultSetup({ curl: 'printf "exit 0\\n"', bun: 'exit 126' })

    expect(result.exitCode).toBe(126)
    expect(result.stdout).not.toContain('npx')
  })

  it('preserves installer failures instead of continuing to Playwright', async () => {
    const result = await runDefaultSetup({ curl: 'printf "exit 17\\n"' })

    expect(result.exitCode).toBe(17)
    expect(result.stdout).not.toContain('bun')
    expect(result.stdout).not.toContain('npx')
  })

  it('stops before downloading bun when package installation fails', async () => {
    const result = await runDefaultSetup({ aptGet: 'exit 100', curl: 'printf "exit 0\\n"' })

    expect(result.exitCode).toBe(100)
    expect(result.stdout).not.toContain('bun')
    expect(result.stdout).not.toContain('npx')
  })

  it('installs bun outside the operator home and verifies it before Playwright', async () => {
    const result = await runDefaultSetup({
      curl: `printf '%s\\n' 'printf "install=%s\\n" "$BUN_INSTALL"'`,
    })

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'install=/usr/local\nbun --version\nnpx -y playwright install-deps chromium\n',
      stderr: '',
    })
  })

  it('keeps the default setup when container.json names no image of its own', async () => {
    const resolution = await resolveWith({
      [`${DIR}/.atlas/container.json`]: JSON.stringify({
        mounts: [{ path: '/Users/operator/Developer/shared-lib' }],
      }),
    })

    expect(resolution.source).toBe(EConfigSource.ContainerJson)
    expect(resolution.image).toEqual({ kind: EImageKind.Image, reference: 'node:22-trixie-slim' })
    expect(resolution.setup).toContain('playwright')
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
