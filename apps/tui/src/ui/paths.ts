export function collapseHome(args: { cwd: string; home: string }): string {
  if (args.home.length === 0) return args.cwd
  if (args.cwd === args.home) return '~'
  if (args.cwd.startsWith(`${args.home}/`)) return `~${args.cwd.slice(args.home.length)}`
  return args.cwd
}

export function expandHome(args: { path: string; home: string }): string {
  if (args.home.length === 0) return args.path
  if (args.path === '~') return args.home
  if (args.path.startsWith('~/')) return `${args.home}${args.path.slice(1)}`
  return args.path
}

const ELLIPSIS = '…'

export function tailOfPath(args: { path: string; cells: number }): string {
  const glyphs = [...args.path]
  if (glyphs.length <= args.cells) return args.path
  if (args.cells <= 1) return ELLIPSIS.slice(0, Math.max(0, args.cells))

  const kept = glyphs.slice(glyphs.length - (args.cells - 1)).join('')
  const boundary = kept.indexOf('/')
  return boundary === -1 ? `${ELLIPSIS}${kept}` : `${ELLIPSIS}${kept.slice(boundary)}`
}
