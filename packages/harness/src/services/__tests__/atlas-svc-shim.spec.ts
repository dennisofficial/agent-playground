import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'bun:test'

import { ATLAS_SVC_NAME, ensureAtlasSvcShim, tryEnsureAtlasSvcShim } from '../atlas-svc-shim'

const roots: string[] = []

function openHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'atlas-svc-home-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function run(args: {
  home: string
  command: string
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn({
    cmd: ['bash', '-c', args.command],
    env: { ...process.env, ATLAS_HOME: args.home, PATH: `${join(args.home, 'bin')}:${process.env.PATH ?? ''}` },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(child.stdout).text()
  const stderr = await new Response(child.stderr).text()
  return { stdout, stderr, exitCode: await child.exited }
}

function plantLog(args: { home: string; name: string; content: string; age?: number }): void {
  const logs = join(args.home, 'services')
  mkdirSync(logs, { recursive: true })
  const path = join(logs, args.name)
  writeFileSync(path, args.content)
  const when = new Date(Date.now() - (args.age ?? 0))
  utimesSync(path, when, when)
}

describe('the atlas-svc shim', () => {
  it('is written executable and not rewritten while unchanged', async () => {
    const home = openHome()
    const bin = join(home, 'bin')

    const first = ensureAtlasSvcShim({ binDirectory: bin })
    expect(first).toBe(join(bin, ATLAS_SVC_NAME))
    expect(statSync(first).mode & 0o111).not.toBe(0)

    const mtime = statSync(first).mtimeMs
    ensureAtlasSvcShim({ binDirectory: bin })
    expect(statSync(first).mtimeMs).toBe(mtime)
  })

  it('survives a bin directory it cannot write', () => {
    expect(tryEnsureAtlasSvcShim({ binDirectory: '/dev/null/nope' })).toBeUndefined()
  })

  it('pipes a service log through whatever the caller builds', async () => {
    const home = openHome()
    ensureAtlasSvcShim({ binDirectory: join(home, 'bin') })
    plantLog({ home, name: 'svc_1.aaaabbbb.log', content: 'ready on 3024\nerror: boom\nready again\n' })

    const piped = await run({ home, command: 'atlas-svc logs svc_1 | grep error' })
    expect(piped.exitCode).toBe(0)
    expect(piped.stdout).toBe('error: boom\n')

    const counted = await run({ home, command: 'atlas-svc logs svc_1 -n 2 | wc -l' })
    expect(counted.stdout.trim()).toBe('2')
  })

  it('resolves a bare id to the newest session’s log', async () => {
    const home = openHome()
    ensureAtlasSvcShim({ binDirectory: join(home, 'bin') })
    plantLog({ home, name: 'svc_1.oldaaaaa.log', content: 'old session\n', age: 60_000 })
    plantLog({ home, name: 'svc_1.newbbbbb.log', content: 'new session\n' })

    const resolved = await run({ home, command: 'atlas-svc path svc_1' })
    expect(resolved.stdout.trim()).toEndWith('svc_1.newbbbbb.log')
  })

  it('lists service ids without their session tokens', async () => {
    const home = openHome()
    ensureAtlasSvcShim({ binDirectory: join(home, 'bin') })
    plantLog({ home, name: 'svc_1.aaaabbbb.log', content: 'one\n' })
    plantLog({ home, name: 'svc_2.aaaabbbb.log', content: 'two\n' })

    const listed = await run({ home, command: 'atlas-svc ls' })
    expect(listed.stdout.trim().split('\n').sort()).toEqual(['svc_1', 'svc_2'])
  })

  it('says so when no log matches the id', async () => {
    const home = openHome()
    ensureAtlasSvcShim({ binDirectory: join(home, 'bin') })

    const missing = await run({ home, command: 'atlas-svc logs svc_9' })
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain('no log for service "svc_9"')
  })
})
