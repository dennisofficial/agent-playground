import { afterEach, describe, expect, it } from 'bun:test'

import {
  applyComposerEdge,
  composerEdge,
  composerEdgeOf,
  composerEdgeVersion,
  EComposerEdge,
  SHIPPED_COMPOSER_EDGE,
  subscribeComposerEdge,
} from '../composer-edge-store'

afterEach(() => {
  applyComposerEdge(SHIPPED_COMPOSER_EDGE)
})

describe('applyComposerEdge', () => {
  it('ships the slab, so the draft a new install sees is the one it always was', () => {
    expect(SHIPPED_COMPOSER_EDGE).toBe(EComposerEdge.Slab)
    expect(composerEdge()).toBe(EComposerEdge.Slab)
  })

  it('bumps a numeric version, which is what useSyncExternalStore snapshots', () => {
    const before = composerEdgeVersion()
    applyComposerEdge(EComposerEdge.Bordered)
    expect(composerEdgeVersion()).toBe(before + 1)
    expect(composerEdge()).toBe(EComposerEdge.Bordered)
  })

  it('says nothing when the edge is already the one asked for', () => {
    applyComposerEdge(EComposerEdge.Bordered)
    let calls = 0
    const unsubscribe = subscribeComposerEdge(() => {
      calls += 1
    })

    applyComposerEdge(EComposerEdge.Bordered)
    unsubscribe()

    expect(calls).toBe(0)
  })

  it('stops calling a listener that unsubscribed', () => {
    let calls = 0
    const unsubscribe = subscribeComposerEdge(() => {
      calls += 1
    })
    unsubscribe()

    applyComposerEdge(EComposerEdge.Bordered)
    expect(calls).toBe(0)
  })
})

describe('composerEdgeOf', () => {
  it('reads the three values the setting offers', () => {
    expect(composerEdgeOf('bordered')).toBe(EComposerEdge.Bordered)
    expect(composerEdgeOf('claude')).toBe(EComposerEdge.Claude)
    expect(composerEdgeOf('slab')).toBe(EComposerEdge.Slab)
  })

  it('falls back to the slab for anything a hand-edited settings file might hold', () => {
    expect(composerEdgeOf('framed')).toBe(EComposerEdge.Slab)
    expect(composerEdgeOf('')).toBe(EComposerEdge.Slab)
  })
})
