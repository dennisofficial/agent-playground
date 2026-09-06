import { describe, expect, it } from 'bun:test'

import { EMountMode } from '../../image/mounts'
import { ensureSandbox } from '../sandbox'
import { fakeEngine, FAKE_CONFIG, systemMounts } from './fake-engine'

describe('ensureSandbox scripts and drift, against a fake engine', () => {
  it('prepares the container for the operator before any script: passwd entry, writable home, relaxed sockets', async () => {
    const { engine: fake, execs } = fakeEngine()

    await ensureSandbox({ engine: fake, config: FAKE_CONFIG })

    const prep = execs[0]?.cmd[2] ?? ''
    expect(execs[0]?.user).toBe('0')
    expect(prep).toContain('/etc/passwd')
    expect(prep).toContain('atlas:x:501:20:atlas:/Users/operator:/bin/sh')
    expect(prep).toContain("chown 501:20 '/Users/operator'")
    expect(prep).toContain(`chmod 666 '${FAKE_CONFIG.dockerSocket}'`)
  })

  it('skips the home chown when the worktree is the home', async () => {
    const { engine: fake, execs } = fakeEngine()

    await ensureSandbox({
      engine: fake,
      config: { ...FAKE_CONFIG, home: FAKE_CONFIG.worktree },
    })

    expect(execs[0]?.cmd[2]).not.toContain('chown 501:20')
  })

  it('refuses failed operator preparation before running setup or start', async () => {
    const { engine: fake, execs } = fakeEngine({ exitCodes: [1] })

    const attempt = ensureSandbox({
      engine: fake,
      config: { ...FAKE_CONFIG, setup: 'apt-get install -y git', start: 'docker compose up -d' },
    })

    await expect(attempt).rejects.toThrow(/operator setup failed/)
    expect(execs).toHaveLength(1)
    expect(execs[0]?.user).toBe('0')
    expect(execs[0]?.cmd[2]).toContain(`chmod 666 '${FAKE_CONFIG.dockerSocket}'`)
  })

  it('runs setup once as root at creation, before start', async () => {
    const { engine: fake, execs } = fakeEngine()

    await ensureSandbox({
      engine: fake,
      config: { ...FAKE_CONFIG, setup: 'apt-get install -y git', start: 'docker compose up -d' },
    })

    expect(execs).toHaveLength(3)
    expect(execs[0]?.cmd[2]).toContain(`chmod 666 '${FAKE_CONFIG.dockerSocket}'`)
    expect(execs[0]?.user).toBe('0')
    expect(execs[1]?.cmd).toEqual(['sh', '-c', 'apt-get install -y git'])
    expect(execs[1]?.user).toBe('0')
    expect(execs[2]?.cmd).toEqual(['sh', '-c', 'docker compose up -d'])
    expect(execs[2]?.user).toBeUndefined()
  })

  it('runs start but not setup when reusing a container', async () => {
    const { engine: fake, execs } = fakeEngine({
      existing: { id: 'kept-1', state: 'running', mounts: systemMounts },
    })

    const sandbox = await ensureSandbox({
      engine: fake,
      config: { ...FAKE_CONFIG, setup: 'apt-get install -y git', start: 'docker compose up -d' },
    })

    expect(sandbox.created).toBe(false)
    expect(execs).toHaveLength(2)
    expect(execs[0]?.cmd[2]).toContain(`chmod 666 '${FAKE_CONFIG.dockerSocket}'`)
    expect(execs[1]?.cmd).toEqual(['sh', '-c', 'docker compose up -d'])
  })

  it('refuses a failed setup loudly rather than serving a container without its toolchain', async () => {
    const { engine: fake } = fakeEngine({ exitCodes: [0, 1] })

    const attempt = ensureSandbox({
      engine: fake,
      config: { ...FAKE_CONFIG, setup: 'apt-get install -y git' },
    })

    await expect(attempt).rejects.toThrow(/setup failed/)
  })

  it('reports a failed start as a warning, not a death', async () => {
    const { engine: fake } = fakeEngine({ exitCodes: [0, 1] })

    const sandbox = await ensureSandbox({
      engine: fake,
      config: { ...FAKE_CONFIG, start: 'docker compose up -d' },
    })

    expect(sandbox.warnings.some((one) => one.includes('start'))).toBe(true)
  })

  it.each([
    { sshKnownHostsPath: '/Users/operator/.ssh/known_hosts' },
    {
      gpgAgentExtraSocket: '/Users/operator/.gnupg/S.gpg-agent.extra',
      gpgPubringPath: '/Users/operator/.gnupg/pubring.kbx',
    },
  ])('refuses reuse without newly requested public identity mounts: %j', async (identity) => {
    const { engine: fake, execs } = fakeEngine({
      existing: { id: 'kept-1', state: 'running', mounts: systemMounts },
    })

    await expect(ensureSandbox({
      engine: fake,
      config: { ...FAKE_CONFIG, ...identity },
    })).rejects.toThrow(/new container/)
    expect(execs).toHaveLength(0)
  })

  it.each([
    [],
    [{ source: '/repo/.git', destination: '/repo/.git', readOnly: true }],
    [{ source: '/other/.git', destination: '/repo/.git', readOnly: false }],
  ])('refuses missing, read-only or substituted Git metadata mounts: %j', async (...mounts) => {
    const { engine, execs } = fakeEngine({
      existing: { id: 'kept-1', state: 'running', mounts: [...systemMounts, ...mounts] },
    })
    await expect(ensureSandbox({
      engine,
      config: { ...FAKE_CONFIG, mounts: [{ path: '/repo/.git', mode: EMountMode.ReadWrite }] },
    })).rejects.toThrow(/new container/)
    expect(execs).toHaveLength(0)
  })

  it('refuses changed mounts on an existing container — a new container is needed, never a recreate', async () => {
    const { engine: fake } = fakeEngine({
      existing: { id: 'kept-1', state: 'running', mounts: systemMounts },
    })

    const attempt = ensureSandbox({
      engine: fake,
      config: {
        ...FAKE_CONFIG,
        mounts: [{ path: '/Users/operator/Developer/shared-lib', mode: EMountMode.ReadOnly }],
      },
    })

    await expect(attempt).rejects.toThrow(/new container/)
  })

  it('refuses mounts removed since creation the same way', async () => {
    const { engine: fake } = fakeEngine({
      existing: {
        id: 'kept-1',
        state: 'running',
        mounts: [
          ...systemMounts,
          {
            source: '/Users/operator/Developer/shared-lib',
            destination: '/Users/operator/Developer/shared-lib',
            readOnly: true,
          },
        ],
      },
    })

    await expect(ensureSandbox({ engine: fake, config: FAKE_CONFIG })).rejects.toThrow(
      /new container/,
    )
  })

  it('refuses reuse when the configured image no longer matches the container’s', async () => {
    const { engine, execs } = fakeEngine({
      existing: {
        id: 'kept-1',
        state: 'running',
        image: 'ghcr.io/dennisofficial/atlas-sandbox:0.1.0',
        mounts: systemMounts,
      },
    })
    await expect(ensureSandbox({ engine, config: FAKE_CONFIG })).rejects.toThrow(/new container/)
    expect(execs).toHaveLength(0)
  })

  it('reuses a container whose mounts still match the config', async () => {
    const { engine: fake } = fakeEngine({
      existing: {
        id: 'kept-1',
        state: 'running',
        mounts: [
          ...systemMounts,
          {
            source: '/Users/operator/Developer/shared-lib',
            destination: '/Users/operator/Developer/shared-lib',
            readOnly: true,
          },
        ],
      },
    })

    const sandbox = await ensureSandbox({
      engine: fake,
      config: {
        ...FAKE_CONFIG,
        mounts: [{ path: '/Users/operator/Developer/shared-lib', mode: EMountMode.ReadOnly }],
      },
    })

    expect(sandbox.created).toBe(false)
    expect(sandbox.id).toBe('kept-1')
  })

  it('treats atlas home subtrees as system mounts, so they never trigger a drift refusal', async () => {
    const { engine: fake } = fakeEngine({
      existing: {
        id: 'kept-1',
        state: 'running',
        mounts: [
          ...systemMounts,
          {
            source: '/Users/operator/.atlas/memory',
            destination: '/Users/operator/.atlas/memory',
            readOnly: true,
          },
        ],
      },
    })

    const sandbox = await ensureSandbox({
      engine: fake,
      config: { ...FAKE_CONFIG, atlasHomeSubtrees: ['/Users/operator/.atlas/memory'] },
    })

    expect(sandbox.created).toBe(false)
    expect(sandbox.id).toBe('kept-1')
  })
})
