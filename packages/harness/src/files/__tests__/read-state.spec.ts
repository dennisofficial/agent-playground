import { describe, expect, it } from 'bun:test'

import { createIsolatedContainer, portToken } from '../../container/injection'
import { FileReadStatePort, InMemoryFileReadState } from '../read-state'
import { registerFileState } from '../register-file-state'

describe('InMemoryFileReadState', () => {
  it('returns a recorded view', () => {
    const state = new InMemoryFileReadState()

    state.record({ path: '/tmp/x/f.ts', view: { mtimeMs: 17, size: 42, wholeFile: true } })

    expect(state.viewOf('/tmp/x/f.ts')).toEqual({ mtimeMs: 17, size: 42, wholeFile: true })
  })

  it('returns undefined for a path that was never read', () => {
    const state = new InMemoryFileReadState()

    expect(state.viewOf('/tmp/x/unseen.ts')).toBeUndefined()
  })

  it('treats two spellings of one path as a single entry', () => {
    const state = new InMemoryFileReadState()

    state.record({ path: '/tmp/x/../x/f.ts', view: { mtimeMs: 5, size: 9, wholeFile: true } })

    expect(state.viewOf('/tmp/x/f.ts')).toEqual({ mtimeMs: 5, size: 9, wholeFile: true })
  })

  it('replaces an earlier view rather than merging into it', () => {
    const state = new InMemoryFileReadState()

    state.record({ path: '/tmp/x/f.ts', view: { mtimeMs: 1, size: 100, wholeFile: true } })
    state.record({ path: '/tmp/x/f.ts', view: { mtimeMs: 2, size: 40, wholeFile: false } })

    expect(state.viewOf('/tmp/x/f.ts')).toEqual({ mtimeMs: 2, size: 40, wholeFile: false })
  })
})

describe('registerFileState', () => {
  it('binds the port to one shared store', () => {
    const container = createIsolatedContainer()
    registerFileState({ container })

    const first = container.resolve(portToken(FileReadStatePort))
    const second = container.resolve(portToken(FileReadStatePort))

    first.record({ path: '/tmp/x/f.ts', view: { mtimeMs: 3, size: 7, wholeFile: true } })

    expect(second).toBe(first)
    expect(second.viewOf('/tmp/x/f.ts')).toEqual({ mtimeMs: 3, size: 7, wholeFile: true })
  })
})
