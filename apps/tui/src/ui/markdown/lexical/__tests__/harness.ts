import { expect } from 'bun:test'

import { createScanner } from '../scanner'
import type { LanguageSpec, LexHighlight } from '../spec'

const scanners = new Map<string, ReturnType<typeof createScanner>>()

function scannerFor(spec: LanguageSpec): ReturnType<typeof createScanner> {
  const cached = scanners.get(spec.filetype)
  if (cached) return cached
  const built = createScanner(spec)
  scanners.set(spec.filetype, built)
  return built
}

export function highlightsFor(args: {
  spec: LanguageSpec
  source: string
}): readonly LexHighlight[] {
  return scannerFor(args.spec)(args.source)
}

export function groupsIn(args: { spec: LanguageSpec; source: string }): ReadonlySet<string> {
  return new Set(highlightsFor(args).map(([, , group]) => group))
}

export function textFor(args: {
  spec: LanguageSpec
  source: string
  group: string
}): readonly string[] {
  return highlightsFor(args)
    .filter(([, , group]) => group === args.group)
    .map(([start, end]) => args.source.slice(start, end))
}

/**
 * Every lexical language is held to the same floor: the groups it claims to emit really appear, no
 * highlight overlaps its neighbour, and none of them runs past the end of the source.
 */
export function expectLexes(args: {
  spec: LanguageSpec
  source: string
  groups: readonly string[]
}): void {
  const highlights = highlightsFor({ spec: args.spec, source: args.source })
  const seen = new Set(highlights.map(([, , group]) => group))
  const name = args.spec.filetype

  for (const group of args.groups) {
    expect([...seen], `${name} is missing @${group}`).toContain(group)
  }

  let previousEnd = 0
  for (const [start, end, group] of highlights) {
    expect(start, `${name} @${group} overlaps its predecessor`).toBeGreaterThanOrEqual(previousEnd)
    expect(end, `${name} @${group} is empty or inverted`).toBeGreaterThan(start)
    expect(end, `${name} @${group} runs past the source`).toBeLessThanOrEqual(args.source.length)
    previousEnd = end
  }
}

export function expectPlain(args: { spec: LanguageSpec; source: string; text: string }): void {
  const start = args.source.indexOf(args.text)
  expect(start, `"${args.text}" is not in the sample`).toBeGreaterThanOrEqual(0)

  const covering = highlightsFor(args)
    .filter(([from, to]) => from <= start && to > start)
    .map(([, , group]) => group)

  expect(covering, `${args.spec.filetype} coloured "${args.text}"`).toEqual([])
}
