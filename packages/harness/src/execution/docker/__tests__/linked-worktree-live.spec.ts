import { describe, expect, it } from 'bun:test'

import { randomUUID } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DockerEngine } from '../engine'
import { sandboxConfigFromHost } from '../host-environment'
import { DEFAULT_DOCKER_SOCKET, ensureSandbox, worktreeLabel, type SandboxConfig } from '../sandbox'
import { runSandboxScript } from '../sandbox-scripts'

const SOCKET = process.env.ATLAS_DOCKER_SOCKET ?? DEFAULT_DOCKER_SOCKET
const PREFIX = `atlas-dev-linked-worktree-${process.pid}-${randomUUID()}`
const engine = new DockerEngine({ socketPath: SOCKET })
const quoted = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

const dockerUnavailableReason = async (): Promise<string | undefined> => {
  try {
    accessSync(SOCKET, constants.R_OK | constants.W_OK)
    const response = await fetch('http://localhost/_ping', {
      unix: SOCKET,
      signal: AbortSignal.timeout(3000),
    })
    if (response.ok && (await response.text()).trim() === 'OK') return undefined
    return `Docker ping returned HTTP ${response.status}`
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const unavailableReason = await dockerUnavailableReason()
if (unavailableReason !== undefined) {
  console.warn(`Skipping live linked-worktree regression: ${SOCKET}: ${unavailableReason}`)
}
const describeDocker = unavailableReason === undefined ? describe : describe.skip

const hostGit = (args: { cwd: string; argv: string[] }): string => {
  const outcome = Bun.spawnSync(['git', '-c', 'core.hooksPath=/dev/null', '-C', args.cwd, ...args.argv], {
    env: {
      PATH: process.env.PATH,
      HOME: args.cwd,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    timeout: 30_000,
  })
  const stdout = new TextDecoder().decode(outcome.stdout)
  const stderr = new TextDecoder().decode(outcome.stderr)
  expect(outcome.exitCode, `${stdout}${stderr}`).toBe(0)
  return stdout.trim()
}

const checkedScript = async (args: {
  containerId: string
  cwd: string
  script: string
}): Promise<string> => {
  const outcome = await runSandboxScript({ engine, ...args, script: `set -eu\n${args.script}` })
  expect(outcome.exitCode, outcome.output).toBe(0)
  return outcome.output
}

const hostIdentity = (): { uid: number; gid: number } => {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  if (uid === undefined || gid === undefined) throw new Error('this platform has no operator uid/gid')
  return { uid, gid }
}

const configForWorktree = (worktree: string): SandboxConfig => ({
  ...sandboxConfigFromHost({
    worktree,
    image: 'node:22-trixie-slim',
    limits: { cpus: 1, memoryBytes: 512 * 1024 ** 2 },
    labelPrefix: PREFIX,
    atlasHomeSubtrees: [],
  }),
  dockerSocket: SOCKET,
  setup: 'apt-get update && apt-get install -y --no-install-recommends git',
  sshAuthSock: undefined,
  sshKnownHostsPath: undefined,
  gitconfigPath: undefined,
  gpgAgentExtraSocket: undefined,
  gpgPubringPath: undefined,
})

describeDocker('linked worktree against a live daemon', () => {
  it('commits as the operator through shared Git metadata without mounting the main working tree, then reuses the sandbox', async () => {
    const fixtureRoot = await mkdtemp(join(await realpath(tmpdir()), 'atlas-linked-worktree-'))
    const main = join(fixtureRoot, 'main')
    const worktree = join(fixtureRoot, 'linked')
    const commonDir = join(main, '.git')
    const mainOnlyFile = join(main, 'main-only.txt')
    try {
      hostGit({ cwd: fixtureRoot, argv: ['init', '--template=', '-b', 'main', main] })
      for (const [key, value] of [
        ['user.name', 'Linked Worktree Fixture'],
        ['user.email', 'linked-worktree@example.invalid'],
        ['commit.gpgsign', 'false'],
      ] as const) {
        hostGit({ cwd: main, argv: ['config', key, value] })
      }
      await writeFile(join(main, 'tracked.txt'), 'baseline\n')
      hostGit({ cwd: main, argv: ['add', 'tracked.txt'] })
      hostGit({ cwd: main, argv: ['commit', '--no-gpg-sign', '-m', 'fixture baseline'] })
      const baseline = hostGit({ cwd: main, argv: ['rev-parse', 'HEAD'] })
      hostGit({ cwd: main, argv: ['worktree', 'add', '-b', 'fixture-linked', worktree] })
      await writeFile(mainOnlyFile, 'not mounted\n')
      const gitDir = hostGit({ cwd: worktree, argv: ['rev-parse', '--absolute-git-dir'] })
      expect(await readFile(join(worktree, '.git'), 'utf8')).toBe(`gitdir: ${gitDir}\n`)
      expect(worktree.startsWith(`${main}/`)).toBe(false)

      const config = configForWorktree(worktree)
      const operator = hostIdentity()
      expect({ uid: config.uid, gid: config.gid }).toEqual(operator)
      const sandbox = await ensureSandbox({ engine, config })
      expect(sandbox.created).toBe(true)
      const details = await engine.inspectContainer({ id: sandbox.id })
      for (const path of [worktree, commonDir]) {
        expect(details.mounts).toContainEqual({ source: path, destination: path, readOnly: false })
      }
      expect(details.mounts.every((mount) => [SOCKET, worktree, commonDir].includes(mount.source))).toBe(true)

      const initialStatus = await checkedScript({
        containerId: sandbox.id,
        cwd: worktree,
        script: `
 test "$(id -u)" = ${config.uid}
 test "$(id -g)" = ${config.gid}
 test "$(pwd -P)" = ${quoted(worktree)}
 test "$(git rev-parse --show-toplevel)" = ${quoted(worktree)}
 test "$(git rev-parse --absolute-git-dir)" = ${quoted(gitDir)}
 test "$(git rev-parse --git-common-dir)" = ${quoted(commonDir)}
 test ! -e ${quoted(mainOnlyFile)}
 git status --porcelain
`,
      })
      expect(initialStatus).toBe('')
      const changedStatus = await checkedScript({
        containerId: sandbox.id,
        cwd: worktree,
        script: "printf 'operator edit\\n' >> tracked.txt\ngit status --porcelain",
      })
      expect(changedStatus).toBe('M tracked.txt')
      expect(await checkedScript({
        containerId: sandbox.id,
        cwd: worktree,
        script: 'git add tracked.txt\ngit diff --cached --name-only',
      })).toBe('tracked.txt')
      await checkedScript({
        containerId: sandbox.id,
        cwd: worktree,
        script: "git -c commit.gpgsign=false commit --no-gpg-sign -m 'unsigned linked fixture'",
      })
      const commit = await checkedScript({
        containerId: sandbox.id,
        cwd: worktree,
        script: 'git rev-parse HEAD',
      })
      expect(commit).not.toBe(baseline)
      expect(hostGit({ cwd: worktree, argv: ['rev-parse', 'HEAD'] })).toBe(commit)
      expect(hostGit({ cwd: main, argv: ['rev-parse', 'fixture-linked'] })).toBe(commit)
      expect(hostGit({ cwd: main, argv: ['rev-parse', 'HEAD'] })).toBe(baseline)
      const commitObject = hostGit({ cwd: worktree, argv: ['cat-file', 'commit', commit] })
      expect(commitObject).toContain('author Linked Worktree Fixture <linked-worktree@example.invalid>')
      expect(commitObject).not.toContain('\ngpgsig ')
      expect(await readFile(join(worktree, 'tracked.txt'), 'utf8')).toBe('baseline\noperator edit\n')
      expect(await readFile(join(main, 'tracked.txt'), 'utf8')).toBe('baseline\n')
      expect(await readFile(mainOnlyFile, 'utf8')).toBe('not mounted\n')
      expect(hostGit({ cwd: worktree, argv: ['status', '--porcelain'] })).toBe('')

      const reused = await ensureSandbox({ engine, config: configForWorktree(worktree) })
      expect(reused.created).toBe(false)
      expect(reused.id).toBe(sandbox.id)
      expect(await checkedScript({
        containerId: reused.id,
        cwd: worktree,
        script: `
 test "$(id -u)" = ${config.uid}
 test "$(git rev-parse HEAD)" = ${quoted(commit)}
 test ! -e ${quoted(mainOnlyFile)}
 git status --porcelain
`,
      })).toBe('')
    } finally {
      const owned = await engine.listContainers({
        labels: { [worktreeLabel(PREFIX)]: worktree },
        all: true,
      })
      for (const container of owned) await engine.removeContainer({ id: container.id })
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  }, 10 * 60_000)
})
