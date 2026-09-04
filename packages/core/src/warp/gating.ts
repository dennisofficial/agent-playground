export interface WarpTerminalEnv {
  WARP_CLI_AGENT_PROTOCOL_VERSION?: string | undefined
  WARP_CLIENT_VERSION?: string | undefined
}

const ATLAS_WARP_PROTOCOL_VERSION = 1

// Stable/preview builds at or before these versions advertised
// WARP_CLI_AGENT_PROTOCOL_VERSION without the HOANotifications feature flag,
// so they claim support they cannot render. Comparison is lexicographic,
// matching the reference implementation:
// https://github.com/warpdotdev/claude-code-warp/blob/main/plugins/warp/scripts/should-use-structured.sh
const LAST_BROKEN_STABLE = 'v0.2026.03.25.08.24.stable_05'
const LAST_BROKEN_PREVIEW = 'v0.2026.03.25.08.24.preview_05'

export function negotiateWarpProtocolVersion({ env }: { env: WarpTerminalEnv }): number {
  const advertised = Number.parseInt(env.WARP_CLI_AGENT_PROTOCOL_VERSION ?? '', 10)
  if (Number.isNaN(advertised)) return ATLAS_WARP_PROTOCOL_VERSION
  return Math.min(advertised, ATLAS_WARP_PROTOCOL_VERSION)
}

export function supportsWarpAgentNotifications({ env }: { env: WarpTerminalEnv }): boolean {
  if (!env.WARP_CLI_AGENT_PROTOCOL_VERSION) return false
  const clientVersion = env.WARP_CLIENT_VERSION
  if (!clientVersion) return false
  if (clientVersion.includes('stable')) return clientVersion > LAST_BROKEN_STABLE
  if (clientVersion.includes('preview')) return clientVersion > LAST_BROKEN_PREVIEW
  return true
}
