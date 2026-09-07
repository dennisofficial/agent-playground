import { describe, expect, it } from 'bun:test'

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EBuildContext } from '../../image/build'
import { ensureSandbox } from '../sandbox'
import { fakeEngine, FAKE_CONFIG, systemMounts } from './fake-engine'

describe('ensureSandbox with a dockerfile-built image, against a fake engine', () => {
  it('builds the image from a dockerfile before creating the container', async () => {
    const context = await mkdtemp(join(tmpdir(), 'atlas-sandbox-dockerfile-'))
    try {
      await writeFile(join(context, 'Dockerfile'), 'FROM scratch\n')
      const { engine, builds, creates } = fakeEngine()

      const sandbox = await ensureSandbox({
        engine,
        config: {
          ...FAKE_CONFIG,
          dockerfile: { path: join(context, 'Dockerfile'), context: EBuildContext.Directory },
        },
      })

      expect(sandbox.created).toBe(true)
      expect(builds).toHaveLength(1)
      expect(builds[0]).toMatch(/^atlas-dockerfile:[0-9a-f]{12}$/)
      expect(creates).toEqual(builds)
    } finally {
      await rm(context, { recursive: true, force: true })
    }
  })

  it('reuses a container whose image matches the dockerfile hash, without rebuilding', async () => {
    const context = await mkdtemp(join(tmpdir(), 'atlas-sandbox-dockerfile-'))
    try {
      await writeFile(join(context, 'Dockerfile'), 'FROM scratch\n')
      const probe = fakeEngine()
      const built = await ensureSandbox({
        engine: probe.engine,
        config: {
          ...FAKE_CONFIG,
          dockerfile: { path: join(context, 'Dockerfile'), context: EBuildContext.Directory },
        },
      })
      const reference = probe.creates[0]
      if (reference === undefined) throw new Error('the probe created nothing')

      const { engine, builds } = fakeEngine({
        existing: { id: 'kept-1', state: 'running', image: reference, mounts: systemMounts },
      })
      const sandbox = await ensureSandbox({
        engine,
        config: {
          ...FAKE_CONFIG,
          dockerfile: { path: join(context, 'Dockerfile'), context: EBuildContext.Directory },
        },
      })

      expect(sandbox.created).toBe(false)
      expect(builds).toHaveLength(0)
    } finally {
      await rm(context, { recursive: true, force: true })
    }
  })

  it('recreates a container whose image no longer matches the dockerfile hash', async () => {
    const context = await mkdtemp(join(tmpdir(), 'atlas-sandbox-dockerfile-'))
    try {
      await writeFile(join(context, 'Dockerfile'), 'FROM scratch\n')
      const { engine, removals, creates } = fakeEngine({
        existing: {
          id: 'kept-1',
          state: 'running',
          image: 'atlas-dockerfile:000000000000',
          mounts: systemMounts,
        },
      })

      const sandbox = await ensureSandbox({
        engine,
        config: {
          ...FAKE_CONFIG,
          dockerfile: { path: join(context, 'Dockerfile'), context: EBuildContext.Directory },
        },
      })

      expect(removals).toEqual(['kept-1'])
      expect(creates).toHaveLength(1)
      expect(sandbox.created).toBe(true)
    } finally {
      await rm(context, { recursive: true, force: true })
    }
  })
})
