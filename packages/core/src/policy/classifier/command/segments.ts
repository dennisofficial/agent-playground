import { ETokenKind, type LexedToken } from './lex'

export enum ESegmentJoin {
  Sequence = 'sequence',
  And = 'and',
  Or = 'or',
  Pipe = 'pipe',
  Background = 'background',
}

export type TokenSegment = {
  words: readonly LexedToken[]
  redirectTargets: readonly LexedToken[]
  joinToNext: ESegmentJoin | undefined
  depth: number
}

const joins: ReadonlyMap<string, ESegmentJoin> = new Map([
  [';', ESegmentJoin.Sequence],
  [';;', ESegmentJoin.Sequence],
  ['\n', ESegmentJoin.Sequence],
  ['&&', ESegmentJoin.And],
  ['||', ESegmentJoin.Or],
  ['|', ESegmentJoin.Pipe],
  ['|&', ESegmentJoin.Pipe],
  ['&', ESegmentJoin.Background],
])

const outputRedirects = new Set(['>', '>>', '>|', '&>', '&>>', '1>', '1>>', '2>', '2>>'])

const isDescriptorDuplicate = (operator: string): boolean => operator.includes('&')

type OpenSegment = {
  words: LexedToken[]
  redirectTargets: LexedToken[]
  depth: number
}

export function splitSegments({
  tokens,
}: {
  tokens: readonly LexedToken[]
}): readonly TokenSegment[] {
  const segments: TokenSegment[] = []
  let depth = 0
  let open: OpenSegment = { words: [], redirectTargets: [], depth }
  let pendingRedirect: string | undefined
  let pendingInput = false

  const close = (joinToNext: ESegmentJoin | undefined): void => {
    if (open.words.length === 0 && open.redirectTargets.length === 0) {
      open = { words: [], redirectTargets: [], depth }
      return
    }
    segments.push({
      words: open.words,
      redirectTargets: open.redirectTargets,
      joinToNext,
      depth: open.depth,
    })
    open = { words: [], redirectTargets: [], depth }
  }

  for (const token of tokens) {
    if (token.kind === ETokenKind.Word) {
      if (pendingRedirect !== undefined) {
        open.redirectTargets.push(token)
        pendingRedirect = undefined
        continue
      }
      if (pendingInput) {
        open.words.push(token)
        pendingInput = false
        continue
      }
      open.words.push(token)
      continue
    }

    pendingRedirect = undefined
    pendingInput = false

    if (token.text === '(') {
      close(undefined)
      depth += 1
      open = { words: [], redirectTargets: [], depth }
      continue
    }

    if (token.text === ')') {
      close(undefined)
      depth = depth === 0 ? 0 : depth - 1
      open = { words: [], redirectTargets: [], depth }
      continue
    }

    if (outputRedirects.has(token.text)) {
      pendingRedirect = token.text
      continue
    }

    if (isDescriptorDuplicate(token.text) && token.text.includes('>')) continue

    if (token.text === '<') {
      pendingInput = true
      continue
    }

    const join = joins.get(token.text)
    if (join === undefined) continue
    close(join)
  }

  close(undefined)
  return segments
}
