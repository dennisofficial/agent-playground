import { cellsOf } from './hint-layout'
import { truncateCells } from './components/sidebar/cells'

export type ShortPath = { directory: string; name: string }

const ELLIPSIS = '…'

const SEPARATOR = '/'

const initialOf = (segment: string): string => {
  const characters = [...segment]
  const head = characters[0]
  if (head === undefined) return segment
  if (head !== '.') return head

  const next = characters[1]
  return next === undefined ? head : `${head}${next}`
}

const directoryOf = (segments: readonly string[]): string =>
  segments.length === 0 ? '' : `${segments.join(SEPARATOR)}${SEPARATOR}`

/**
 * A path too wide for its row gives up its outermost directories first, each shrinking to its
 * initial the way powerlevel10k shortens a prompt: the file name and the folder holding it are the
 * last things to go, because they are what the eye actually reads.
 */
export function shortenPath(args: { path: string; cells: number }): ShortPath {
  const trailing = args.path.endsWith(SEPARATOR)
  const parts = (trailing ? args.path.slice(0, -1) : args.path).split(SEPARATOR)
  const name = `${parts.at(-1) ?? args.path}${trailing ? SEPARATOR : ''}`
  const segments = [...parts.slice(0, -1)]

  const fits = (directory: string): boolean => cellsOf(`${directory}${name}`) <= args.cells

  if (fits(directoryOf(segments))) return { directory: directoryOf(segments), name }

  const innermost = segments.length - 1
  for (let index = 0; index < segments.length; index += 1) {
    if (index === innermost) continue

    const segment = segments[index]
    if (segment !== undefined) segments[index] = initialOf(segment)
    if (fits(directoryOf(segments))) return { directory: directoryOf(segments), name }
  }

  const last = segments[innermost]
  if (last !== undefined) segments[innermost] = initialOf(last)
  if (fits(directoryOf(segments))) return { directory: directoryOf(segments), name }

  while (segments.length > 0) {
    segments.shift()
    const directory = `${ELLIPSIS}${SEPARATOR}${directoryOf(segments)}`
    if (fits(directory)) return { directory, name }
  }

  return { directory: '', name: truncateCells({ text: name, cells: args.cells }) }
}
