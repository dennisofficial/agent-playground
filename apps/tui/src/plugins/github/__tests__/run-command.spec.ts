import { describe, expect, it } from 'bun:test'
import { tmpdir } from 'node:os'

import { ESpawnFailure, spawnCommand } from '../run-command'

const TIMEOUT_MS = 10_000

describe('spawnCommand', () => {
  it('runs a command and reports no failure', async () => {
    const run = await spawnCommand({
      argv: ['echo', 'hello'],
      cwd: tmpdir(),
      timeoutMs: TIMEOUT_MS,
    })

    expect(run.failure).toBeNull()
    expect(run.code).toBe(0)
    expect(run.stdout.trim()).toBe('hello')
  })

  it('carries a non-zero exit without calling it a spawn failure', async () => {
    const run = await spawnCommand({
      argv: ['sh', '-c', 'echo bad >&2; exit 3'],
      cwd: tmpdir(),
      timeoutMs: TIMEOUT_MS,
    })

    expect(run.failure).toBeNull()
    expect(run.code).toBe(3)
    expect(run.stderr.trim()).toBe('bad')
  })

  /**
   * Bun raises ENOENT for a missing binary *and* for a working directory that is not there, so the
   * errno alone cannot tell them apart — the directory is asked about directly instead.
   */
  it('blames the directory, not the binary, when the working directory is gone', async () => {
    const run = await spawnCommand({
      argv: ['echo', 'hello'],
      cwd: '/atlas-does-not-exist/nowhere',
      timeoutMs: TIMEOUT_MS,
    })

    expect(run.failure).toBe(ESpawnFailure.DirectoryUnusable)
  })

  it('blames the directory when the working directory is a file', async () => {
    const run = await spawnCommand({
      argv: ['echo', 'hello'],
      cwd: '/etc/hosts',
      timeoutMs: TIMEOUT_MS,
    })

    expect(run.failure).toBe(ESpawnFailure.DirectoryUnusable)
  })

  it('blames the binary only when the directory is fine', async () => {
    const run = await spawnCommand({
      argv: ['atlas-no-such-binary-anywhere'],
      cwd: tmpdir(),
      timeoutMs: TIMEOUT_MS,
    })

    expect(run.failure).toBe(ESpawnFailure.BinaryMissing)
  })
})
