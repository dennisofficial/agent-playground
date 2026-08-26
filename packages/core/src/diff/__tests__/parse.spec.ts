import { describe, expect, it } from 'bun:test'

import { EDiffLine } from '../hunk'
import { parseUnifiedDiff } from '../parse'

const lines = (patch: string) => parseUnifiedDiff(patch)[0]?.hunks[0]?.lines ?? []

describe('parseUnifiedDiff', () => {
  it('reads a single hunk with its heading and start lines', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/src/app.ts b/src/app.ts',
        'index 1111111..2222222 100644',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -10,3 +12,4 @@ function render() {',
        ' const a = 1',
        '-const b = 2',
        '+const b = 3',
        '+const c = 4',
        ' return a',
      ].join('\n'),
    )

    expect(files).toHaveLength(1)
    expect(files[0]?.path).toBe('src/app.ts')
    expect(files[0]?.previousPath).toBeNull()
    expect(files[0]?.added).toBe(2)
    expect(files[0]?.removed).toBe(1)
    expect(files[0]?.hunks[0]?.heading).toBe('function render() {')
    expect(files[0]?.hunks[0]?.oldStart).toBe(10)
    expect(files[0]?.hunks[0]?.newStart).toBe(12)
  })

  it('numbers each side only where that side has the line', () => {
    const parsed = lines(
      [
        '--- a/x.ts',
        '+++ b/x.ts',
        '@@ -1,3 +1,4 @@',
        ' keep',
        '-gone',
        '+fresh',
        '+extra',
        ' tail',
      ].join('\n'),
    )

    expect(parsed.map((line) => [line.kind, line.oldNumber, line.newNumber])).toEqual([
      [EDiffLine.Context, 1, 1],
      [EDiffLine.Removed, 2, null],
      [EDiffLine.Added, null, 2],
      [EDiffLine.Added, null, 3],
      [EDiffLine.Context, 3, 4],
    ])
  })

  it('carries the text without its diff marker', () => {
    const parsed = lines(
      ['--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '-  old()', '+  new()'].join('\n'),
    )

    expect(parsed.map((line) => line.text)).toEqual(['  old()', '  new()'])
  })

  it('emits no line for the no-newline marker', () => {
    const parsed = lines(
      [
        '--- a/x.ts',
        '+++ b/x.ts',
        '@@ -1,2 +1,2 @@',
        ' kept',
        '-old',
        '\\ No newline at end of file',
        '+new',
        '\\ No newline at end of file',
      ].join('\n'),
    )

    expect(parsed.map((line) => line.text)).toEqual(['kept', 'old', 'new'])
  })

  it('keeps a context line that is empty', () => {
    const parsed = lines(
      ['--- a/x.ts', '+++ b/x.ts', '@@ -1,3 +1,3 @@', ' a', '', '-b', '+c'].join('\n'),
    )

    expect(parsed.map((line) => [line.kind, line.text])).toEqual([
      [EDiffLine.Context, 'a'],
      [EDiffLine.Context, ''],
      [EDiffLine.Removed, 'b'],
      [EDiffLine.Added, 'c'],
    ])
  })

  it('reads a removed line whose own text opens with dashes', () => {
    const parsed = lines(
      ['--- a/x.ts', '+++ b/x.ts', '@@ -1,2 +1,2 @@', '--- not a header', '+++ nor this'].join(
        '\n',
      ),
    )

    expect(parsed.map((line) => [line.kind, line.text])).toEqual([
      [EDiffLine.Removed, '-- not a header'],
      [EDiffLine.Added, '++ nor this'],
    ])
  })
})
