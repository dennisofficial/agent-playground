import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ATLAS_SETTINGS,
  EExecutionLocation,
  executionLocationNote,
} from '@dltech/atlas-core'
import {
  createHarnessContainer,
  createSettingsService,
  DockerEngine,
  MemorySettingsStore,
} from '@dltech/atlas-harness'
import { afterEach, describe, expect, it } from 'bun:test'

import { createExecutionLocationState } from '../execution-location-state'
import { bindSandbox } from '../sandbox-binding'

const projects: string[] = []

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => rm(project, { recursive: true })))
})

const freshProject = async (containerJson?: string): Promise<string> => {
  const project = await mkdtemp(join(tmpdir(), 'atlas-sandbox-binding-'))
  projects.push(project)
  if (containerJson !== undefined) {
    await mkdir(join(project, '.atlas'))
    await writeFile(join(project, '.atlas', 'container.json'), containerJson)
  }
  return project
}

const bindIn = (cwd: string) =>
  bindSandbox({
    container: createHarnessContainer(),
    engine: new DockerEngine({ socketPath: join(cwd, 'no-daemon.sock') }),
    cwd,
    settings: createSettingsService({
      definitions: ATLAS_SETTINGS,
      user: new MemorySettingsStore({ label: 'sandbox-binding spec' }),
    }),
    executionLocation: createExecutionLocationState({ initial: EExecutionLocation.Docker }),
  })

describe('the mounts bindSandbox hands the tail block', () => {
  it('names a configured mount in the note the model reads', async () => {
    const cwd = await freshProject(
      JSON.stringify({ mounts: [{ path: '/Users/operator/Developer/shared-lib' }] }),
    )

    const { mounts } = await bindIn(cwd)

    const note = executionLocationNote({ location: EExecutionLocation.Docker, mounts })
    expect(note).toContain('/Users/operator/Developer/shared-lib')
  })

  it('keeps the boundary warning for a path outside the configured mounts', async () => {
    const cwd = await freshProject(
      JSON.stringify({ mounts: [{ path: '/Users/operator/Developer/shared-lib' }] }),
    )

    const { mounts } = await bindIn(cwd)

    const note = executionLocationNote({ location: EExecutionLocation.Docker, mounts })
    expect(note).toContain('not mounted')
  })

  it('warns that any path outside the project is unmounted when nothing is configured', async () => {
    const cwd = await freshProject()

    const { mounts } = await bindIn(cwd)

    expect(mounts).toEqual([])
    const note = executionLocationNote({ location: EExecutionLocation.Docker, mounts })
    expect(note).toContain('A path outside the project is not mounted')
  })
})
