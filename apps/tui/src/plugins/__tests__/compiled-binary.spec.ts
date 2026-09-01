import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

const IDENTITY_PLUGIN = `
import { BeforeToolHook, definePlugin, EStage } from 'atlas'

export const token = BeforeToolHook
export const stage = EStage

export default definePlugin({ id: 'identity', register: () => ({}) })
`

const runCapturing = async (args: {
  command: readonly string[]
  cwd: string
}): Promise<{ code: number; stdout: string; stderr: string }> => {
  const spawned = Bun.spawn([...args.command], {
    cwd: args.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, code] = await Promise.all([
    new Response(spawned.stdout).text(),
    new Response(spawned.stderr).text(),
    spawned.exited,
  ])

  return { code, stdout, stderr }
}

describe('a plugin loaded by a compiled binary', () => {
  it('gets the host own class and enum, not a second copy', async () => {
    const tuiRoot = join(import.meta.dir, '..', '..', '..')
    const pluginDirectory = mkdtempSync(join(tmpdir(), 'atlas-compiled-plugins-'))
    const binary = join(mkdtempSync(join(tmpdir(), 'atlas-compiled-bin-')), 'probe')

    writeFileSync(join(pluginDirectory, 'identity.ts'), IDENTITY_PLUGIN)

    const built = await runCapturing({
      cwd: tuiRoot,
      command: [
        'bun',
        'build',
        '--compile',
        join(import.meta.dir, 'compiled-binary-entry.ts'),
        '--outfile',
        binary,
      ],
    })

    expect(built.stderr).not.toContain('error:')
    expect(built.code).toBe(0)

    const ran = await runCapturing({ cwd: tuiRoot, command: [binary, pluginDirectory] })

    expect(ran.stderr).toBe('')
    expect(ran.code).toBe(0)

    const reported: unknown = JSON.parse(ran.stdout)

    expect(reported).toEqual({
      loaded: ['identity'],
      refused: [],
      identicalClass: true,
      identicalEnum: true,
    })
  }, 180_000)
})
