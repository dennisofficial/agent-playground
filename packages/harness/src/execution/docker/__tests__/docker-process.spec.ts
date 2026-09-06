import { afterAll, describe, expect, it } from 'bun:test'

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ProcessHandle, ProcessPort } from '@dltech/atlas-core'

import { LocalProcessPort, SIGKILL_GRACE_MS } from '../../local-process'
import { DockerProcessPort } from '../docker-process'
import { DockerEngine } from '../engine'
import { dockerUnavailableReason } from './live-docker'
import { worktreeLabel, type SandboxConfig } from '../sandbox'

const textOf = async (stream: ReadableStream<Uint8Array>): Promise<string> =>
  await new Response(stream).text()

const run = async (args: {
  port: ProcessPort
  cmd: readonly string[]
  cwd: string
  env?: Record<string, string | undefined>
}): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const handle = args.port.spawn({ cmd: [...args.cmd], cwd: args.cwd, env: args.env })
  const [stdout, stderr, exitCode] = await Promise.all([
    textOf(handle.stdout),
    textOf(handle.stderr),
    handle.exited,
  ])
  return { stdout, stderr, exitCode }
}

const awaitMarker = async (handle: ProcessHandle, marker: string): Promise<void> => {
  const reader = handle.stdout.getReader()
  const decoder = new TextDecoder()
  let seen = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      seen += decoder.decode(value, { stream: true })
      if (seen.includes(marker)) return
    }
  } finally {
    reader.releaseLock()
  }
}

const SOCKET = '/var/run/docker.sock'
const DOCKER_AVAILABLE = (await dockerUnavailableReason(SOCKET)) === undefined

const engine = new DockerEngine({ socketPath: SOCKET })
const PREFIX = 'atlas-dev'

const worktree = await realpath(await mkdtemp(join(tmpdir(), 'atlas-dev-port-parity-')))
const dockerWorktree = await realpath(await mkdtemp(join(tmpdir(), 'atlas-dev-port-docker-')))

const sweep = async (): Promise<void> => {
  if (!DOCKER_AVAILABLE) return
  const stale = await engine.listContainers({
    labels: { [worktreeLabel(PREFIX)]: undefined },
    all: true,
  })
  for (const container of stale) await engine.removeContainer({ id: container.id })
}

afterAll(async () => {
  await sweep()
  await rm(worktree, { recursive: true, force: true })
  await rm(dockerWorktree, { recursive: true, force: true })
})

const sandboxConfig = (): SandboxConfig => ({
  image: 'node:22-slim',
  worktree: dockerWorktree,
  uid: 501,
  gid: 20,
  home: '/Users/operator',
  limits: { cpus: 1, memoryBytes: 512 * 1024 ** 2 },
  dockerSocket: SOCKET,
  labelPrefix: PREFIX,
})

type AdapterUnderTest = {
  name: string
  make: () => ProcessPort
  cwd: string
}

const adapters: readonly AdapterUnderTest[] = [
  { name: 'local', make: () => new LocalProcessPort(), cwd: worktree },
  {
    name: 'docker',
    make: () => new DockerProcessPort({ engine, sandbox: sandboxConfig() }),
    cwd: dockerWorktree,
  },
]

for (const adapter of adapters) {
  const describeAdapter = adapter.name === 'docker' && !DOCKER_AVAILABLE ? describe.skip : describe

  describeAdapter(`${adapter.name} adapter`, () => {
    it('produces the same stdout, stderr and exit code for the same command', async () => {
      const result = await run({
        port: adapter.make(),
        cmd: ['bash', '-c', 'echo out; echo err >&2; exit 3'],
        cwd: adapter.cwd,
      })

      expect(result).toEqual({ stdout: 'out\n', stderr: 'err\n', exitCode: 3 })
    }, 30_000)

    it('passes env through to the command', async () => {
      const result = await run({
        port: adapter.make(),
        cmd: ['bash', '-c', 'echo "$PORT_MARKER"'],
        cwd: adapter.cwd,
        env: { PORT_MARKER: 'forwarded' },
      })

      expect(result).toEqual({ stdout: 'forwarded\n', stderr: '', exitCode: 0 })
    }, 30_000)

    it('reaches stdout EOF only once a forked process holding the pipe exits', async () => {
      const handle = adapter.make().spawn({
        cmd: ['bash', '-c', '(trap "" TERM; echo ready; exec sleep 2) & exit 0'],
        cwd: adapter.cwd,
      })
      await awaitMarker(handle, 'ready')

      const beganAt = Date.now()
      const reader = handle.stdout.getReader()
      for (;;) {
        const { done } = await reader.read()
        if (done) break
      }

      expect(Date.now() - beganAt).toBeGreaterThanOrEqual(1_500)
    }, 30_000)

    it('terminates a process with SIGTERM and stays idempotent under repeated calls', async () => {
      const handle = adapter.make().spawn({ cmd: ['sleep', '30'], cwd: adapter.cwd })

      handle.terminate()
      handle.terminate()
      const exitCode = await handle.exited
      handle.terminate()

      expect(exitCode).toBe(143)
    }, 30_000)

    it('escalates to SIGKILL after the grace when SIGTERM is ignored', async () => {
      const handle = adapter.make().spawn({
        cmd: ['bash', '-c', 'trap "" TERM; echo ready; exec sleep 30'],
        cwd: adapter.cwd,
      })
      await awaitMarker(handle, 'ready')

      const beganAt = Date.now()
      handle.terminate()
      const exitCode = await handle.exited

      expect(exitCode).toBe(137)
      expect(Date.now() - beganAt).toBeGreaterThanOrEqual(SIGKILL_GRACE_MS)
    }, 30_000)

    it('locates sh and misses an unknown command', async () => {
      const port = adapter.make()
      await run({ port, cmd: ['true'], cwd: adapter.cwd })

      expect(port.which({ command: 'sh' })).toEndWith('/sh')
      expect(port.which({ command: 'atlas-no-such-command' })).toBeNull()
    }, 30_000)
  })
}

const describeDocker = DOCKER_AVAILABLE ? describe : describe.skip

describeDocker('DockerProcessPort specifically', () => {
  it('runs the command inside a container that sees the worktree at its identical path', async () => {
    const port = new DockerProcessPort({ engine, sandbox: sandboxConfig() })

    const result = await run({
      port,
      cmd: ['bash', '-c', 'pwd; echo from-container > identical-path-marker.txt'],
      cwd: dockerWorktree,
    })

    expect(result.stdout).toBe(`${dockerWorktree}\n`)
    expect(result.exitCode).toBe(0)
    await expect(readFile(join(dockerWorktree, 'identical-path-marker.txt'), 'utf8')).resolves.toBe(
      'from-container\n',
    )
  }, 30_000)

  it('substitutes the container PATH for a host PATH so the shell still resolves', async () => {
    const port = new DockerProcessPort({ engine, sandbox: sandboxConfig() })

    const result = await run({
      port,
      cmd: ['bash', '-c', 'echo works'],
      cwd: dockerWorktree,
      env: { PATH: '/nonexistent-host-path' },
    })

    expect(result).toEqual({ stdout: 'works\n', stderr: '', exitCode: 0 })
  }, 30_000)

  it('collects an oversubscription warning when the request outruns the daemon', async () => {
    const info = await engine.info()
    const port = new DockerProcessPort({
      engine,
      sandbox: {
        ...sandboxConfig(),
        worktree: await realpath(await mkdtemp(join(tmpdir(), 'atlas-dev-port-oversubscribed-'))),
        limits: { cpus: 1, memoryBytes: info.memoryBytes * 2 },
      },
    })

    await run({ port, cmd: ['true'], cwd: '/' })

    expect(port.warnings.length).toBeGreaterThan(0)
    expect(port.warnings[0]).toContain('memory')
  }, 30_000)

  const sshAuthSock = process.env.SSH_AUTH_SOCK
  const itWithAgent =
    DOCKER_AVAILABLE && sshAuthSock !== undefined && existsSync(sshAuthSock) ? it : it.skip

  itWithAgent('forwards the ssh agent socket where the operator uid can reach it', async () => {
    const agentWorktree = await realpath(await mkdtemp(join(tmpdir(), 'atlas-dev-port-agent-')))
    const port = new DockerProcessPort({
      engine,
      sandbox: { ...sandboxConfig(), worktree: agentWorktree, sshAuthSock },
    })

    const script = `
      const net = require('net');
      const s = net.connect(process.env.SSH_AUTH_SOCK);
      s.on('connect', () => s.write(Buffer.from([0, 0, 0, 1, 11])));
      s.on('data', () => { console.log('agent-reply'); process.exit(0); });
      s.on('error', (error) => { console.log('connect-error ' + error.message); process.exit(1); });
      setTimeout(() => process.exit(2), 4000);
    `
    const result = await run({ port, cmd: ['node', '-e', script], cwd: agentWorktree })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('agent-reply')
  }, 30_000)
})
