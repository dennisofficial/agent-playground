export type FoundInPage = {
  excerpt: string
  /** How many lines matched. */
  matched: number
  /** How many passages were rendered, of `blocks` the page actually holds. */
  shown: number
  blocks: number
}

export type FindOutcome = { ok: true; found: FoundInPage } | { ok: false; reason: string }

const MAX_BLOCKS = 20

const GAP = '...'

/**
 * The pattern is matched a line at a time rather than against the whole page.
 *
 * A page is up to a hundred thousand characters and the pattern comes from the model, so matching
 * the two against each other invites a backtracking blowup no timeout here could interrupt. A line
 * is short enough that a pathological pattern stays cheap.
 */
export function findInPage(args: { body: string; pattern: string; context: number }): FindOutcome {
  let expression: RegExp
  try {
    expression = new RegExp(args.pattern, 'i')
  } catch (error) {
    return {
      ok: false,
      reason: `"${args.pattern}" is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const lines = args.body.split('\n')
  const hits: number[] = []
  for (const [index, line] of lines.entries()) {
    if (expression.test(line)) hits.push(index)
  }

  if (hits.length === 0) {
    return { ok: true, found: { excerpt: '', matched: 0, shown: 0, blocks: 0 } }
  }

  const blocks: { from: number; to: number }[] = []
  for (const hit of hits) {
    const from = Math.max(0, hit - args.context)
    const to = Math.min(lines.length - 1, hit + args.context)
    const last = blocks.at(-1)

    if (last !== undefined && from <= last.to + 1) {
      last.to = Math.max(last.to, to)
      continue
    }
    blocks.push({ from, to })
  }

  const shown = blocks.slice(0, MAX_BLOCKS)
  const excerpt = shown
    .map((block) => lines.slice(block.from, block.to + 1).join('\n'))
    .join(`\n${GAP}\n`)

  return {
    ok: true,
    found: { excerpt, matched: hits.length, shown: shown.length, blocks: blocks.length },
  }
}

export function renderFound(args: { found: FoundInPage; pattern: string }): string {
  const { matched, shown, blocks } = args.found
  if (matched === 0) {
    return `The page was fetched but nothing in it matches /${args.pattern}/. Fetch it without a pattern to read the whole page.`
  }

  const heading = `${matched} line${matched === 1 ? '' : 's'} match /${args.pattern}/`
  const elided = shown < blocks ? `, showing the first ${shown} of ${blocks} passages` : ''

  return `${heading}${elided}.`
}
