export function collapseHome(args: { cwd: string; home: string }): string {
  if (args.home.length === 0) return args.cwd
  if (args.cwd === args.home) return '~'
  if (args.cwd.startsWith(`${args.home}/`)) return `~${args.cwd.slice(args.home.length)}`
  return args.cwd
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

export type WhereLabel = { path: string; moved: boolean }

export function sessionLabel(args: {
  projectDirectory: string
  sessionDirectory: string
  home: string
}): WhereLabel {
  const project = collapseHome({ cwd: args.projectDirectory, home: args.home })
  if (args.sessionDirectory === args.projectDirectory) return { path: project, moved: false }

  const inside = `${args.projectDirectory}/`
  if (args.sessionDirectory.startsWith(inside)) {
    return { path: args.sessionDirectory.slice(inside.length), moved: true }
  }

  return { path: collapseHome({ cwd: args.sessionDirectory, home: args.home }), moved: true }
}
