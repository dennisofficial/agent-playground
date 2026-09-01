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

const shortenSegment = (segment: string): string => {
  const glyphs = [...segment]
  const dotted = glyphs[0] === '.'
  const kept = glyphs.slice(0, dotted ? 2 : 1).join('')
  return kept.length < segment.length ? kept : segment
}

export function compactPath(args: { path: string; cells: number }): string {
  const segments = args.path.split('/')
  if (segments.length < 3) return tailOfPath(args)

  const compacted = [...segments]
  const last = compacted.length - 1

  for (let index = 0; index < last; index += 1) {
    if ([...compacted.join('/')].length <= args.cells) return compacted.join('/')
    const segment = segments[index]
    if (segment !== undefined) compacted[index] = shortenSegment(segment)
  }

  const shortest = compacted.join('/')
  return [...shortest].length <= args.cells ? shortest : tailOfPath({ ...args, path: shortest })
}
