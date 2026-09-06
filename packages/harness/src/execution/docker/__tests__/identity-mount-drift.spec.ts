import { describe, expect, it } from 'bun:test'

import { EMountMode } from '../../image/mounts'
import {
  declaredMountsDrift,
  declaredMountsLabel,
  encodeDeclaredMounts,
  missingIdentityMounts,
} from '../mount-drift'
import type { ContainerDetails } from '../engine'
import type { SandboxConfig } from '../sandbox'

const config: SandboxConfig = {
  image: 'node:22-trixie-slim', worktree: '/project', uid: 501, gid: 20,
  home: '/home/operator', dockerSocket: '/var/run/docker.sock',
  limits: { cpus: 1, memoryBytes: 1024 ** 3 },
  sshKnownHostsPath: '/home/operator/.ssh/known_hosts',
  gpgAgentExtraSocket: '/home/operator/.gnupg/S.gpg-agent.extra',
  gpgPubringPath: '/home/operator/.gnupg/pubring.kbx',
}
const actual = [
  { source: '/home/operator/.ssh/known_hosts', destination: '/home/operator/.ssh/known_hosts', readOnly: true },
  { source: '/home/operator/.gnupg/pubring.kbx', destination: '/run/atlas/gnupg/pubring.kbx', readOnly: true },
]

describe('missing identity mounts', () => {
  it('warns about nothing when every identity file is mounted', () => {
    expect(missingIdentityMounts({ config, actual })).toEqual([])
  })

  it('warns rather than refuses when an identity file appeared after creation', () => {
    const warnings = missingIdentityMounts({ config, actual: [] })

    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('known_hosts')
    expect(warnings[1]).toContain('pubring.kbx')
  })

  it('warns rather than refuses when a mounted identity mount went writable or was substituted', () => {
    const warnings = missingIdentityMounts({
      config,
      actual: actual.map((mount) => ({ ...mount, readOnly: false })),
    })

    expect(warnings).toHaveLength(2)
  })

  it('asks for no keyring without a forwarded agent', () => {
    expect(
      missingIdentityMounts({
        config: { ...config, gpgAgentExtraSocket: undefined },
        actual: actual.slice(0, 1),
      }),
    ).toEqual([])
  })
})

const details = (args: {
  labels: Record<string, string>
  mounts?: ContainerDetails['mounts']
}): ContainerDetails => ({
  id: 'kept-1',
  name: 'atlas-deadbeef1234',
  state: { running: true },
  config: { labels: args.labels, env: [], image: 'node:22-trixie-slim' },
  mounts: args.mounts ?? [],
  ports: [],
  hostConfig: { nanoCpus: 0, memoryBytes: 0 },
})

describe('declared mounts drift, label-stamped at creation', () => {
  it('reuses a labeled container whose declared mounts still match, whatever the live mounts look like', () => {
    const labeled = details({ labels: { [declaredMountsLabel('atlas')]: encodeDeclaredMounts([]) } })

    expect(declaredMountsDrift({ config, details: labeled, prefix: 'atlas' })).toBe(false)
  })

  it('drifts when the declared mounts no longer match the label', () => {
    const labeled = details({ labels: { [declaredMountsLabel('atlas')]: encodeDeclaredMounts([]) } })

    expect(
      declaredMountsDrift({
        config: { ...config, mounts: [{ path: '/data/shared', mode: EMountMode.ReadOnly }] },
        details: labeled,
        prefix: 'atlas',
      }),
    ).toBe(true)
  })

  it('encodes order-insensitively, so a reordered container.json is not drift', () => {
    const mounts = [
      { path: '/data/b', mode: EMountMode.ReadWrite },
      { path: '/data/a', mode: EMountMode.ReadOnly },
    ] as const
    const labeled = details({
      labels: { [declaredMountsLabel('atlas')]: encodeDeclaredMounts([...mounts].reverse()) },
    })

    expect(
      declaredMountsDrift({ config: { ...config, mounts: [...mounts] }, details: labeled, prefix: 'atlas' }),
    ).toBe(false)
  })

  it('falls back to comparing live mounts for a container created before the label existed', () => {
    const unlabeled = details({
      labels: {},
      mounts: [
        { source: '/project', destination: '/project', readOnly: false },
        { source: '/var/run/docker.sock', destination: '/var/run/docker.sock', readOnly: false },
        ...actual,
      ],
    })

    expect(declaredMountsDrift({ config, details: unlabeled, prefix: 'atlas' })).toBe(false)
    expect(
      declaredMountsDrift({
        config: { ...config, mounts: [{ path: '/data/shared', mode: EMountMode.ReadOnly }] },
        details: unlabeled,
        prefix: 'atlas',
      }),
    ).toBe(true)
  })

  it('does not drift an unlabeled container over an identity file that vanished since creation', () => {
    const bare: SandboxConfig = {
      ...config,
      sshKnownHostsPath: undefined,
      gpgAgentExtraSocket: undefined,
      gpgPubringPath: undefined,
    }
    const unlabeled = details({
      labels: {},
      mounts: [
        { source: '/project', destination: '/project', readOnly: false },
        { source: '/var/run/docker.sock', destination: '/var/run/docker.sock', readOnly: false },
        ...actual,
      ],
    })

    expect(declaredMountsDrift({ config: bare, details: unlabeled, prefix: 'atlas' })).toBe(false)
  })
})
