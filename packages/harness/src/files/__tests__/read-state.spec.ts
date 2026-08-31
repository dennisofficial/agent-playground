import { describe, expect, it } from 'bun:test'

import { toThreadId } from '@dltech/atlas-core'

import { createIsolatedContainer, portToken } from '../../container/injection'
import { FileReadStatePort, InMemoryFileReadState } from '../read-state'
import { registerFileState } from '../register-file-state'

const parent = toThreadId('thread-parent')
const child = toThreadId('thread-child')

describe('InMemoryFileReadState', () => {
  it('returns a view recorded by the same thread', () => {
    const state = new InMemoryFileReadState()

    state.record({ threadId: parent, path: '/tmp/x/f.ts', view: { mtimeMs: 17, size: 42, wholeFile: true, digest: 'd1' } })

    expect(state.viewOf({ threadId: parent, path: '/tmp/x/f.ts' })).toEqual({
      mtimeMs: 17,
      size: 42,
      wholeFile: true,
      digest: 'd1',
    })
  })

  it('returns undefined for a path that was never read', () => {
    const state = new InMemoryFileReadState()

    expect(state.viewOf({ threadId: parent, path: '/tmp/x/unseen.ts' })).toBeUndefined()
  })

  it('treats two spellings of one path as a single entry within a thread', () => {
    const state = new InMemoryFileReadState()

    state.record({
      threadId: parent,
      path: '/tmp/x/../x/f.ts',
      view: { mtimeMs: 5, size: 9, wholeFile: true, digest: 'd1' },
    })

    expect(state.viewOf({ threadId: parent, path: '/tmp/x/f.ts' })).toEqual({
      mtimeMs: 5,
      size: 9,
      wholeFile: true,
      digest: 'd1',
    })
  })

  it('replaces an earlier view rather than merging into it', () => {
    const state = new InMemoryFileReadState()

    state.record({ threadId: parent, path: '/tmp/x/f.ts', view: { mtimeMs: 1, size: 100, wholeFile: true, digest: 'd1' } })
    state.record({ threadId: parent, path: '/tmp/x/f.ts', view: { mtimeMs: 2, size: 40, wholeFile: false, digest: 'd1' } })

    expect(state.viewOf({ threadId: parent, path: '/tmp/x/f.ts' })).toEqual({
      mtimeMs: 2,
      size: 40,
      wholeFile: false,
      digest: 'd1',
    })
  })

  it('does not let one thread read a view another thread recorded', () => {
    const state = new InMemoryFileReadState()

    state.record({ threadId: child, path: '/tmp/x/f.ts', view: { mtimeMs: 17, size: 42, wholeFile: true, digest: 'd1' } })

    expect(state.viewOf({ threadId: parent, path: '/tmp/x/f.ts' })).toBeUndefined()
  })

  it('keeps the two threads views of one path independent of each other', () => {
    const state = new InMemoryFileReadState()

    state.record({ threadId: parent, path: '/tmp/x/f.ts', view: { mtimeMs: 1, size: 10, wholeFile: true, digest: 'd1' } })
    state.record({ threadId: child, path: '/tmp/x/f.ts', view: { mtimeMs: 2, size: 20, wholeFile: false, digest: 'd1' } })

    expect(state.viewOf({ threadId: parent, path: '/tmp/x/f.ts' })).toEqual({
      mtimeMs: 1,
      size: 10,
      wholeFile: true,
      digest: 'd1',
    })
    expect(state.viewOf({ threadId: child, path: '/tmp/x/f.ts' })).toEqual({
      mtimeMs: 2,
      size: 20,
      wholeFile: false,
      digest: 'd1',
    })
  })

  it('keeps the paths within one thread separate from each other', () => {
    const state = new InMemoryFileReadState()

    state.record({ threadId: parent, path: '/tmp/x/f.ts', view: { mtimeMs: 1, size: 10, wholeFile: true, digest: 'd1' } })

    expect(state.viewOf({ threadId: parent, path: '/tmp/x/g.ts' })).toBeUndefined()
  })
})

describe('registerFileState', () => {
  it('binds the port to one shared store', () => {
    const container = createIsolatedContainer()
    registerFileState({ container })

    const first = container.resolve(portToken(FileReadStatePort))
    const second = container.resolve(portToken(FileReadStatePort))

    first.record({ threadId: parent, path: '/tmp/x/f.ts', view: { mtimeMs: 3, size: 7, wholeFile: true, digest: 'd1' } })

    expect(second).toBe(first)
    expect(second.viewOf({ threadId: parent, path: '/tmp/x/f.ts' })).toEqual({
      mtimeMs: 3,
      size: 7,
      wholeFile: true,
      digest: 'd1',
    })
  })

  it('shares one store across threads without sharing what each thread has seen', () => {
    const container = createIsolatedContainer()
    registerFileState({ container })

    const store = container.resolve(portToken(FileReadStatePort))
    store.record({ threadId: child, path: '/tmp/x/f.ts', view: { mtimeMs: 3, size: 7, wholeFile: true, digest: 'd1' } })

    expect(store.viewOf({ threadId: parent, path: '/tmp/x/f.ts' })).toBeUndefined()
  })
})
