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
  ])('reuses with a warning when a public identity file appears after creation: %j', async (identity) => {
    const { engine: fake } = fakeEngine({
      existing: { id: 'kept-1', state: 'running', mounts: systemMounts },
    })

    const sandbox = await ensureSandbox({
      engine: fake,
      config: { ...FAKE_CONFIG, ...identity },
    })

    expect(sandbox.created).toBe(false)
    expect(sandbox.id).toBe('kept-1')
    expect(sandbox.warnings.some((one) => one.includes('next recreate'))).toBe(true)
  })

  it.each([
    [],
    [{ source: '/repo/.git', destination: '/repo/.git', readOnly: true }],
    [{ source: '/other/.git', destination: '/repo/.git', readOnly: false }],
  ])('recreates on missing, read-only or substituted Git metadata mounts: %j', async (...mounts) => {
    const { engine, removals, creates } = fakeEngine({
      existing: { id: 'kept-1', state: 'running', mounts: [...systemMounts, ...mounts] },
    })

    const sandbox = await ensureSandbox({
      engine,
      config: { ...FAKE_CONFIG, mounts: [{ path: '/repo/.git', mode: EMountMode.ReadWrite }] },
    })

    expect(removals).toEqual(['kept-1'])
    expect(creates).toHaveLength(1)
    expect(sandbox.created).toBe(true)
  })

  it('recreates a running container whose declared mounts drifted, warning that its shells died', async () => {
    const { engine: fake, removals, creates } = fakeEngine({
      existing: { id: 'kept-1', state: 'running', mounts: systemMounts },
    })

    const sandbox = await ensureSandbox({
      engine: fake,
      config: {
        ...FAKE_CONFIG,
        mounts: [{ path: '/Users/operator/Developer/shared-lib', mode: EMountMode.ReadOnly }],
      },
    })

    expect(removals).toEqual(['kept-1'])
    expect(creates).toHaveLength(1)
    expect(sandbox.created).toBe(true)
    expect(sandbox.warnings.some((one) => one.includes('shells'))).toBe(true)
  })

  it('recreates mounts removed since creation the same way, while the container runs', async () => {
    const { engine: fake, removals, creates } = fakeEngine({
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

    const sandbox = await ensureSandbox({ engine: fake, config: FAKE_CONFIG })

    expect(removals).toEqual(['kept-1'])
    expect(creates).toHaveLength(1)
    expect(sandbox.created).toBe(true)
  })

  it('recreates a stopped container whose declared mounts drifted, noting nothing live was lost', async () => {
    const { engine: fake, removals, creates } = fakeEngine({
      existing: { id: 'stale-1', state: 'exited', mounts: systemMounts },
    })

    const sandbox = await ensureSandbox({
      engine: fake,
      config: {
        ...FAKE_CONFIG,
        mounts: [{ path: '/Users/operator/Developer/shared-lib', mode: EMountMode.ReadOnly }],
      },
    })

    expect(removals).toEqual(['stale-1'])
    expect(creates).toHaveLength(1)
    expect(sandbox.created).toBe(true)
    expect(sandbox.warnings.some((one) => one.includes('recreated'))).toBe(true)
  })

  it('recreates a running container when the configured image no longer matches, warning that its shells died', async () => {
    const { engine, removals, creates } = fakeEngine({
      existing: {
        id: 'kept-1',
        state: 'running',
        image: 'ghcr.io/dennisofficial/atlas-sandbox:0.1.0',
        mounts: systemMounts,
      },
    })

    const sandbox = await ensureSandbox({ engine, config: FAKE_CONFIG })

    expect(removals).toEqual(['kept-1'])
    expect(creates).toEqual([FAKE_CONFIG.image])
    expect(sandbox.created).toBe(true)
    expect(sandbox.warnings.some((one) => one.includes('shells'))).toBe(true)
  })

  it('recreates a stopped container whose image drifted', async () => {
    const { engine, removals, creates } = fakeEngine({
      existing: {
        id: 'stale-1',
        state: 'exited',
        image: 'ghcr.io/dennisofficial/atlas-sandbox:0.1.0',
        mounts: systemMounts,
      },
    })

    const sandbox = await ensureSandbox({ engine, config: FAKE_CONFIG })

    expect(removals).toEqual(['stale-1'])
    expect(creates).toEqual([FAKE_CONFIG.image])
    expect(sandbox.created).toBe(true)
  })

  it('does not drift on volatile host inputs: identity files that existed at creation but vanished since', async () => {
    const { engine: fake } = fakeEngine({
      existing: {
        id: 'kept-1',
        state: 'running',
        mounts: [
          ...systemMounts,
          {
            source: '/Users/operator/.ssh/known_hosts',
            destination: '/Users/operator/.ssh/known_hosts',
            readOnly: true,
          },
        ],
      },
    })

    const sandbox = await ensureSandbox({ engine: fake, config: FAKE_CONFIG })

    expect(sandbox.created).toBe(false)
    expect(sandbox.id).toBe('kept-1')
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
