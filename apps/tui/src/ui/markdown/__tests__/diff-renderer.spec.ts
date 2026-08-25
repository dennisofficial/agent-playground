import { describe, expect, it } from 'bun:test'

import { classifyDiffLine, diffRenderer } from '../renderers/diff'

describe('classifyDiffLine', () => {
  it('claims file headers before it claims added and removed lines', () => {
    // `---`/`+++` start with the same characters as a change, and misreading them opens every diff
    // with a false pair — which is why this is ordered rather than a lookup table.
    expect(classifyDiffLine('--- a/src/app.ts')).toBe('meta')
    expect(classifyDiffLine('+++ b/src/app.ts')).toBe('meta')
    expect(classifyDiffLine('-  const x = 1;')).toBe('removed')
    expect(classifyDiffLine('+  const x = 2;')).toBe('added')
  })

  it('reads hunk ranges, git preamble, and context', () => {
    expect(classifyDiffLine('@@ -1,4 +1,4 @@ export function fit()')).toBe('hunk')
    expect(classifyDiffLine('diff --git a/x b/x')).toBe('meta')
    expect(classifyDiffLine('index 0a1b2c3..4d5e6f7 100644')).toBe('meta')
    expect(classifyDiffLine('   return 1;')).toBe('context')
    expect(classifyDiffLine('')).toBe('context')
  })
})

describe('diffRenderer', () => {
  it('claims diff and patch, and nothing else', () => {
    expect(diffRenderer.handles('diff')).toBe(true)
    expect(diffRenderer.handles('patch')).toBe(true)
    expect(diffRenderer.handles('typescript')).toBe(false)
  })

  it('measures the block at its longest line, so the panner has a range to work with', () => {
    const view = diffRenderer.render({
      source: '+short\n-a much longer line here',
      language: 'diff',
      width: 10,
    })
    expect(view.rows).toBe(2)
    expect(view.columns).toBe('-a much longer line here'.length)
  })
})
