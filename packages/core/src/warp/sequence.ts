// OSC 7 is undocumented for Warp (its docs list only OSC 8/9/52/777/1337) but
// verified: the file tree, branch indicator, PR chip and agent session card
// all follow it. Only % and space are percent-encoded — Warp accepts the rest
// raw. ST-terminated, matching dennisofficial/claude-warp-cwd warp-emit.sh.
export function buildWarpCwdSequence({ cwd, host }: { cwd: string; host: string }): string {
  const encoded = cwd.replaceAll('%', '%25').replaceAll(' ', '%20')
  return `\x1b]7;file://${host}${encoded}\x1b\\`
}
