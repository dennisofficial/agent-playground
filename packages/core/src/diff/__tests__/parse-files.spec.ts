import { describe, expect, it } from 'bun:test'

import { EDiffLine } from '../hunk'
import { parseUnifiedDiff } from '../parse'

describe('parseUnifiedDiff and the files a patch names', () => {
  it('splits a patch that touches several files', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/one.ts b/one.ts',
        '--- a/one.ts',
        '+++ b/one.ts',
        '@@ -1 +1 @@',
        '-one',
        '+uno',
        'diff --git a/two.ts b/two.ts',
        '--- a/two.ts',
        '+++ b/two.ts',
        '@@ -5 +5 @@',
        '-two',
        '+dos',
      ].join('\n'),
    )

    expect(files.map((file) => file.path)).toEqual(['one.ts', 'two.ts'])
    expect(files.map((file) => file.hunks.length)).toEqual([1, 1])
    expect(files[1]?.hunks[0]?.oldStart).toBe(5)
  })

  it('keeps every hunk of a file that changed in two places', () => {
    const file = parseUnifiedDiff(
      [
        '--- a/x.ts',
        '+++ b/x.ts',
        '@@ -1,2 +1,2 @@',
        '-a',
        '+b',
        ' c',
        '@@ -40,2 +40,2 @@ tail',
        '-y',
        '+z',
        ' w',
      ].join('\n'),
    )[0]

    expect(file?.hunks).toHaveLength(2)
    expect(file?.hunks[1]?.newStart).toBe(40)
    expect(file?.added).toBe(2)
    expect(file?.removed).toBe(2)
  })

  it('marks a file created when the old side is /dev/null', () => {
    const file = parseUnifiedDiff(
      [
        'diff --git a/new.ts b/new.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new.ts',
        '@@ -0,0 +1,2 @@',
        '+first',
        '+second',
      ].join('\n'),
    )[0]

    expect(file?.path).toBe('new.ts')
    expect(file?.created).toBe(true)
    expect(file?.deleted).toBe(false)
    expect(file?.added).toBe(2)
  })

  it('marks a file deleted when the new side is /dev/null', () => {
    const file = parseUnifiedDiff(
      [
        'diff --git a/old.ts b/old.ts',
        'deleted file mode 100644',
        '--- a/old.ts',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-first',
        '-second',
      ].join('\n'),
    )[0]

    expect(file?.path).toBe('old.ts')
    expect(file?.deleted).toBe(true)
    expect(file?.created).toBe(false)
    expect(file?.removed).toBe(2)
  })

  it('records where a renamed file came from', () => {
    const file = parseUnifiedDiff(
      [
        'diff --git a/src/old-name.ts b/src/new-name.ts',
        'similarity index 92%',
        'rename from src/old-name.ts',
        'rename to src/new-name.ts',
        '--- a/src/old-name.ts',
        '+++ b/src/new-name.ts',
        '@@ -1 +1 @@',
        '-before',
        '+after',
      ].join('\n'),
    )[0]

    expect(file?.path).toBe('src/new-name.ts')
    expect(file?.previousPath).toBe('src/old-name.ts')
  })

  it('reads a rename that carries no hunk at all', () => {
    const file = parseUnifiedDiff(
      [
        'diff --git a/a.ts b/b.ts',
        'similarity index 100%',
        'rename from a.ts',
        'rename to b.ts',
      ].join('\n'),
    )[0]

    expect(file?.path).toBe('b.ts')
    expect(file?.previousPath).toBe('a.ts')
    expect(file?.hunks).toEqual([])
  })

  it('treats an omitted hunk count as a single line', () => {
    const hunk = parseUnifiedDiff(
      ['--- a/x.ts', '+++ b/x.ts', '@@ -7 +7 @@', '-old', '+new'].join('\n'),
    )[0]?.hunks[0]

    expect(hunk?.oldStart).toBe(7)
    expect(hunk?.newStart).toBe(7)
    expect(hunk?.lines.map((line) => line.kind)).toEqual([EDiffLine.Removed, EDiffLine.Added])
  })

  it('yields nothing for input that is not a patch', () => {
    expect(parseUnifiedDiff('')).toEqual([])
    expect(parseUnifiedDiff('just some prose\nover two lines')).toEqual([])
    expect(parseUnifiedDiff('@@ -1 +1 @@\n-orphan hunk')).toEqual([])
  })

  it('skips a garbled header instead of throwing', () => {
    expect(() => parseUnifiedDiff('diff --git\n@@ @@\n--- \n+++ ')).not.toThrow()
    expect(parseUnifiedDiff('diff --git\n@@ @@\n--- \n+++ ')).toEqual([])
  })

  it('tolerates carriage returns from a windows patch', () => {
    const file = parseUnifiedDiff(
      ['--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '-old', '+new'].join('\r\n'),
    )[0]

    expect(file?.path).toBe('x.ts')
    expect(file?.added).toBe(1)
  })
})

describe('parseUnifiedDiff and git prefixes', () => {
  it('strips the mnemonic prefixes git uses in place of a/ and b/', () => {
    const file = parseUnifiedDiff(
      [
        'diff --git c/apps/tui/theme.ts w/apps/tui/theme.ts',
        '--- c/apps/tui/theme.ts',
        '+++ w/apps/tui/theme.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n'),
    )[0]

    expect(file?.path).toBe('apps/tui/theme.ts')
  })

  it('reads a patch written without any path prefix', () => {
    const file = parseUnifiedDiff(
      ['--- src/x.ts', '+++ src/x.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n'),
    )[0]

    expect(file?.path).toBe('src/x.ts')
  })

  it('keeps the timestamp off a path from a posix diff', () => {
    const file = parseUnifiedDiff(
      [
        '--- x.ts\t2026-08-26 10:00:00.000000000 +0000',
        '+++ x.ts\t2026-08-26 10:01:00.000000000 +0000',
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n'),
    )[0]

    expect(file?.path).toBe('x.ts')
  })
})
