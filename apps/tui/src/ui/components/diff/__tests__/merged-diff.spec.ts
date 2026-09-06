import { describe, expect, it } from 'bun:test'

import { EDiffLine } from '@dltech/atlas-core'

import { aCall, CWD } from '../../../../store/tools/__tests__/fixture'
import { mergedDiffOf } from '../merged-diff'

const PATCH_ONE = `--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,3 @@
 const nine = 9
-oldRef
+newRef
 const eleven = 11
`

const PATCH_TWO = `--- a/src/a.ts
+++ b/src/a.ts
@@ -20,3 +20,3 @@
 const nineteen = 19
-oldTarget
+newTarget
 const twentyOne = 21
`

const edit = (diff: string) =>
  aCall({ name: 'edit', input: { path: `${CWD}/src/a.ts` }, output: { path: `${CWD}/src/a.ts`, diff } })

describe('mergedDiffOf', () => {
  it('stacks both passes into one file, with a seam where the second pass begins', () => {
    const merged = mergedDiffOf({ calls: [edit(PATCH_ONE), edit(PATCH_TWO)], cwd: CWD, context: 2 })
    if (merged === null) throw new Error('two patched edits make a merged diff')

    expect(merged.file.path).toBe('src/a.ts')
    expect(merged.file.added).toBe(2)
    expect(merged.file.removed).toBe(2)
    expect(merged.file.hunks).toHaveLength(2)

    const [firstHunk, secondHunk] = merged.file.hunks
    expect(firstHunk?.lines.some((line) => line.kind === EDiffLine.Elision)).toBe(false)
    const seam = secondHunk?.lines[0]
    expect(seam?.kind).toBe(EDiffLine.Elision)
    expect(seam?.elided).toBeUndefined()
    expect(secondHunk?.lines.some((line) => line.text === 'newTarget')).toBe(true)
  })

  it('copies as the two patches in the order they landed, which is the applicable patch', () => {
    const merged = mergedDiffOf({ calls: [edit(PATCH_ONE), edit(PATCH_TWO)], cwd: CWD, context: 2 })
    if (merged === null) throw new Error('two patched edits make a merged diff')

    expect(merged.patch).toBe([PATCH_ONE, PATCH_TWO].join('\n'))
  })

  it('collapses long unchanged runs inside each pass, as a lone diff would', () => {
    const wide = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,9 +1,9 @@
 one
 two
 three
 four
 five
 six
 seven
-old
+new
 nine
`
    const merged = mergedDiffOf({ calls: [edit(wide), edit(PATCH_TWO)], cwd: CWD, context: 2 })
    if (merged === null) throw new Error('two patched edits make a merged diff')

    const elision = merged.file.hunks[0]?.lines.find((line) => line.kind === EDiffLine.Elision)
    expect(elision?.elided).toBe(3)
  })

  it('declines a call with no patch to stack', () => {
    const unpatched = aCall({
      name: 'edit',
      input: { path: `${CWD}/src/a.ts` },
      output: { path: `${CWD}/src/a.ts`, added: 1, removed: 1 },
    })

    expect(mergedDiffOf({ calls: [edit(PATCH_ONE), unpatched], cwd: CWD, context: 2 })).toBeNull()
  })
})
