import { describe, expect, it } from 'bun:test'

import { randomUUID } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { EMountMode } from '../../image/mounts'
import { DEFAULT_CONTAINER_SETUP } from '../../image/resolve'
import { DockerEngine } from '../engine'
import { DEFAULT_DOCKER_SOCKET, DEFAULT_SANDBOX_IMAGE, ensureSandbox, worktreeLabel } from '../sandbox'
import { runSandboxScript } from '../sandbox-scripts'

const SOCKET = DEFAULT_DOCKER_SOCKET
const PREFIX = `atlas-dev-toolchain-${process.pid}-${randomUUID()}`
const SCRATCH = resolve(import.meta.dir, '../../../../../..', '.scratch')
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
  console.warn(`Skipping live toolchain acceptance: ${SOCKET}: ${unavailableReason}`)
}
const describeDocker = unavailableReason === undefined ? describe : describe.skip

const checkedScript = async (args: {
  containerId: string
  cwd: string
  script: string
  user?: string
}): Promise<string> => {
  const outcome = await runSandboxScript({ engine, ...args, script: `set -eu\n${args.script}` })
  expect(outcome.exitCode, outcome.output).toBe(0)
  return outcome.output
}

const bunFixtureScript = `
mkdir -p bun-fixture/dependency
cd bun-fixture
cat > package.json <<'JSON'
{"name":"toolchain-fixture","private":true,"type":"module","dependencies":{"acceptance-value":"file:./dependency"}}
JSON
cat > dependency/package.json <<'JSON'
{"name":"acceptance-value","version":"1.0.0","type":"module","exports":"./index.js"}
JSON
printf 'export const value = 42\\n' > dependency/index.js
cat > acceptance.spec.ts <<'TEST'
import { expect, test } from 'bun:test'
import { value } from 'acceptance-value'
test('installed dependency is executable', () => expect(value).toBe(42))
TEST
bun install
test -f bun.lock
bun test acceptance.spec.ts
`

const seedRepositories = (args: { worktree: string; outside: string }): string => {
  const commands = [
    `git init -b main ${quoted(args.worktree)}`,
    `git -C ${quoted(args.worktree)} config user.name 'Sandbox Acceptance'`,
    `git -C ${quoted(args.worktree)} config user.email 'acceptance@example.invalid'`,
    `git -C ${quoted(args.worktree)} config commit.gpgsign false`,
    `printf 'baseline\\n' > ${quoted(join(args.worktree, 'tracked.txt'))}`,
    `git -C ${quoted(args.worktree)} add tracked.txt`,
    `git -C ${quoted(args.worktree)} commit -m baseline`,
  ]
  for (const directory of ['.atlas', '.claude']) {
    const parent = join(args.worktree, directory, 'worktrees', 'parent')
    const nested = join(parent, directory, 'worktrees', 'child')
    commands.push(
      `git -C ${quoted(args.worktree)} worktree add -b ${directory.slice(1)}-parent ${quoted(parent)}`,
      `git -C ${quoted(parent)} worktree add -b ${directory.slice(1)}-child ${quoted(nested)}`,
    )
  }
  commands.push(
    `git init -b main ${quoted(args.outside)}`,
    `chown -R 0:0 ${quoted(args.worktree)} ${quoted(args.outside)}`,
    `chmod -R a+rwX ${quoted(args.worktree)} ${quoted(args.outside)}`,
  )
  return commands.join('\n')
}

describeDocker('fresh default sandbox toolchain acceptance', () => {
  it('runs Bun as the operator and trusts later nested linked worktrees without trusting their sibling', async () => {
    await mkdir(SCRATCH, { recursive: true })
    const fixtureRoot = await mkdtemp(join(SCRATCH, 'toolchain-acceptance-'))
    const worktree = join(fixtureRoot, 'project')
    const outside = join(fixtureRoot, 'project-outside')
    try {
      await mkdir(worktree)
      await chmod(worktree, 0o777)
      await mkdir(outside)
      const sandbox = await ensureSandbox({
        engine,
        config: {
          image: DEFAULT_SANDBOX_IMAGE,
          setup: DEFAULT_CONTAINER_SETUP,
          worktree,
          uid: 501,
          gid: 20,
          home: '/home/atlas-toolchain-acceptance',
          limits: { cpus: 2, memoryBytes: 2 * 1024 ** 3 },
          dockerSocket: SOCKET,
          labelPrefix: PREFIX,
          mounts: [{ path: outside, mode: EMountMode.ReadWrite }],
        },
      })
      expect(sandbox.created).toBe(true)
      const identity = await checkedScript({
        containerId: sandbox.id,
        cwd: worktree,
        script: `
printf 'operator=%s:%s:%s\\n' "$(id -u)" "$(id -g)" "$(whoami)"
test -w "$HOME"
printf 'writable\\n' > "$HOME/acceptance-marker"
test -r ${quoted(SOCKET)} && test -w ${quoted(SOCKET)}
test ! -e .atlas/worktrees && test ! -e .claude/worktrees
command -v bun
bun --version
git --version
rg --version
gpg --version
curl --version
ssh -V
`,
      })
      expect(identity).toContain('operator=501:20:atlas')
      expect(identity).toContain('/usr/local/bin/bun')
      const bunOutput = await checkedScript({
        containerId: sandbox.id,
        cwd: worktree,
        script: bunFixtureScript,
      })
      expect(bunOutput).toContain('1 pass')
      expect(bunOutput).toContain('0 fail')

      await checkedScript({
        containerId: sandbox.id,
        cwd: worktree,
        user: '0',
        script: seedRepositories({ worktree, outside }),
      })
      for (const directory of ['.atlas', '.claude']) {
        const nested = join(worktree, directory, 'worktrees', 'parent', directory, 'worktrees', 'child')
        const initialStatus = await checkedScript({
          containerId: sandbox.id,
          cwd: nested,
          script: `
test "$(id -u)" = 501
test -f .git
test "$(stat -c %u .)" = 0
test "$(stat -c %u .git)" = 0
test "$(git rev-parse --git-common-dir)" = ${quoted(join(worktree, '.git'))}
test "$(stat -c %u ${quoted(join(worktree, '.git'))})" = 0
git status --short
`,
        })
        expect(initialStatus).toBe('')
        const changedStatus = await checkedScript({
          containerId: sandbox.id,
          cwd: nested,
          script: "printf 'operator edit\\n' >> tracked.txt\ngit status --short",
        })
        expect(changedStatus).toBe('M tracked.txt')
        const commit = await checkedScript({
          containerId: sandbox.id,
          cwd: nested,
          script: "git add tracked.txt\ngit commit -m 'operator acceptance'\ngit log -1 --format=%s",
        })
        expect(commit).toContain('operator acceptance')
        expect(await checkedScript({
          containerId: sandbox.id,
          cwd: nested,
          script: 'git status --short',
        })).toBe('')
      }

      await checkedScript({
        containerId: sandbox.id,
        cwd: outside,
        script: 'test "$(id -u)" = 501\ntest "$(stat -c %u .)" = 0\ntest "$(stat -c %u .git)" = 0',
      })
      for (const script of ['git status --short', "git commit --allow-empty -m 'must refuse'"]) {
        const refused = await runSandboxScript({ engine, containerId: sandbox.id, cwd: outside, script })
        expect(refused.exitCode, refused.output).toBe(128)
        expect(refused.output).toContain('detected dubious ownership')
      }
    } finally {
      const owned = await engine.listContainers({
        labels: { [worktreeLabel(PREFIX)]: worktree },
        all: true,
      })
      for (const container of owned) await engine.removeContainer({ id: container.id })
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  }, 20 * 60_000)
})
