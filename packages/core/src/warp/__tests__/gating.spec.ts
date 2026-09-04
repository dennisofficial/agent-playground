import { describe, expect, it } from 'bun:test'

import { negotiateWarpProtocolVersion, supportsWarpAgentNotifications } from '../gating'

describe('supportsWarpAgentNotifications', () => {
  it('returns false without the protocol version env var', () => {
    expect(supportsWarpAgentNotifications({ env: {} })).toBe(false)
  })

  it('returns false when the client version is missing', () => {
    expect(
      supportsWarpAgentNotifications({
        env: { WARP_CLI_AGENT_PROTOCOL_VERSION: '1' },
      }),
    ).toBe(false)
  })

  it('returns true for a current stable build', () => {
    expect(
      supportsWarpAgentNotifications({
        env: {
          WARP_CLI_AGENT_PROTOCOL_VERSION: '1',
          WARP_CLIENT_VERSION: 'v0.2026.09.01.08.00.stable_00',
        },
      }),
    ).toBe(true)
  })

  it('returns false for the last broken stable build', () => {
    expect(
      supportsWarpAgentNotifications({
        env: {
          WARP_CLI_AGENT_PROTOCOL_VERSION: '1',
          WARP_CLIENT_VERSION: 'v0.2026.03.25.08.24.stable_05',
        },
      }),
    ).toBe(false)
  })

  it('returns false for stable builds before the broken threshold', () => {
    expect(
      supportsWarpAgentNotifications({
        env: {
          WARP_CLI_AGENT_PROTOCOL_VERSION: '1',
          WARP_CLIENT_VERSION: 'v0.2026.03.01.08.00.stable_00',
        },
      }),
    ).toBe(false)
  })

  it('returns false for the last broken preview build', () => {
    expect(
      supportsWarpAgentNotifications({
        env: {
          WARP_CLI_AGENT_PROTOCOL_VERSION: '1',
          WARP_CLIENT_VERSION: 'v0.2026.03.25.08.24.preview_05',
        },
      }),
    ).toBe(false)
  })

  it('returns true for dev builds without a threshold', () => {
    expect(
      supportsWarpAgentNotifications({
        env: {
          WARP_CLI_AGENT_PROTOCOL_VERSION: '1',
          WARP_CLIENT_VERSION: 'v0.2026.01.01.00.00.dev_00',
        },
      }),
    ).toBe(true)
  })
})

describe('negotiateWarpProtocolVersion', () => {
  it('falls back to 1 when Warp does not advertise a version', () => {
    expect(negotiateWarpProtocolVersion({ env: {} })).toBe(1)
  })

  it('takes the minimum of the advertised and supported versions', () => {
    expect(
      negotiateWarpProtocolVersion({ env: { WARP_CLI_AGENT_PROTOCOL_VERSION: '3' } }),
    ).toBe(1)
  })

  it('honors a lower advertised version', () => {
    expect(
      negotiateWarpProtocolVersion({ env: { WARP_CLI_AGENT_PROTOCOL_VERSION: '0' } }),
    ).toBe(0)
  })

  it('falls back to 1 for an unparseable version', () => {
    expect(
      negotiateWarpProtocolVersion({ env: { WARP_CLI_AGENT_PROTOCOL_VERSION: 'abc' } }),
    ).toBe(1)
  })
})
