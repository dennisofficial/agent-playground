export interface WarpTerminalEnv {
  TERM_PROGRAM?: string | undefined
}

export function isWarpTerminal({ env }: { env: WarpTerminalEnv }): boolean {
  return env.TERM_PROGRAM === 'WarpTerminal'
}
