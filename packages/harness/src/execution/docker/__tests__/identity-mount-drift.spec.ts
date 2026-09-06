import { describe, expect, it } from 'bun:test'

import { publicIdentityMountsDrift } from '../mount-drift'
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

describe('public identity mount drift', () => {
  it('reuses matching read-only public identity mounts', () => {
    expect(publicIdentityMountsDrift({ config, actual })).toBe(false)
  })

  it.each([0, 1])('refuses writable or substituted identity mount %i', (at) => {
    expect(publicIdentityMountsDrift({
      config, actual: actual.map((mount, index) => index === at ? { ...mount, readOnly: false } : mount),
    })).toBe(true)
    expect(publicIdentityMountsDrift({
      config, actual: actual.map((mount, index) => index === at ? { ...mount, source: '/wrong/file' } : mount),
    })).toBe(true)
  })

  it('requires no keyring without a forwarded agent', () => {
    expect(publicIdentityMountsDrift({
      config: { ...config, gpgAgentExtraSocket: undefined }, actual: actual.slice(0, 1),
    })).toBe(false)
  })
})
