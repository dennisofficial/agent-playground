import { afterAll, describe, expect, it } from 'bun:test'

import {
  registerFallbackRenderer,
  registerFencedRenderer,
  rendererFor,
  resetFencedRenderers,
  type FencedRenderer,
} from '../registry'
import { codeRenderer, plainRenderer } from '../renderers/code'
import { diffRenderer } from '../renderers/diff'

// The registry is module state and `markdown-view.tsx` fills it from a module-scope side effect that
// cannot run twice, so a spec that empties it has to put the production set back for the spec files
// after it in the same process.
afterAll(() => {
  resetFencedRenderers()
  registerFencedRenderer(diffRenderer)
  registerFencedRenderer(codeRenderer)
  registerFallbackRenderer(plainRenderer)
})

function renderer(args: { name: string; handles: (language: string) => boolean }): FencedRenderer {
  return {
    name: args.name,
    handles: args.handles,
    render: () => ({ node: null, columns: 0, rows: 0 }),
  }
}

describe('rendererFor', () => {
  it('hands a language to the first renderer that claims it, so order is precedence', () => {
    resetFencedRenderers()
    registerFencedRenderer(renderer({ name: 'narrow', handles: (l) => l === 'diff' }))
    registerFencedRenderer(renderer({ name: 'broad', handles: (l) => l.length > 0 }))
    registerFallbackRenderer(renderer({ name: 'fallback', handles: () => true }))

    expect(rendererFor('diff').name).toBe('narrow')
    expect(rendererFor('ts').name).toBe('broad')
    expect(rendererFor('').name).toBe('fallback')
  })

  it('replaces the fallback rather than stacking a second one', () => {
    resetFencedRenderers()
    registerFallbackRenderer(renderer({ name: 'first', handles: () => true }))
    registerFallbackRenderer(renderer({ name: 'second', handles: () => true }))

    expect(rendererFor('').name).toBe('second')
  })

  it('throws rather than silently dropping a fence when nothing is registered', () => {
    resetFencedRenderers()
    expect(() => rendererFor('ts')).toThrow('no fallback fenced renderer registered')
  })
})
