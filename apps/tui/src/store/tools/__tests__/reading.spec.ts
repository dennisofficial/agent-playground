import { describe, expect, it } from 'bun:test'

import { ECallState } from '../../tool-runs'
import { detailOf, dictatedContentOf, reasonOf } from '../reading'
import { aCall } from './fixture'

describe('what an opened call has to show', () => {
  it('shows what a command printed on BOTH streams, not only stdout', () => {
    const call = aCall({
      name: 'bash',
      output: { command: 'tsc', stdout: 'checking…', stderr: 'error TS2345', exitCode: 2 },
    })

    expect(detailOf(call)).toEqual(['checking…', 'error TS2345'])
  })

  it('falls back to the stream that spoke when stdout was silent', () => {
    const call = aCall({ name: 'bash', output: { stdout: '', stderr: 'permission denied' } })

    expect(detailOf(call)).toEqual(['permission denied'])
  })

  it('hands back the reason a call never ran', () => {
    const call = aCall({ name: 'write', state: ECallState.Denied, note: 'outside the workspace' })

    expect(reasonOf(call)).toBe('outside the workspace')
    expect(reasonOf(aCall({ name: 'read' }))).toBe('')
  })
})

describe('what a call is still dictating', () => {
  it('reads a write’s whole file off the call', () => {
    const call = aCall({ name: 'write', input: { path: '/repo/a.ts', content: 'const a = 1' } })

    expect(dictatedContentOf(call)).toBe('const a = 1')
  })

  it('reads an edit’s replacement text off the call', () => {
    const call = aCall({
      name: 'edit',
      input: { path: '/repo/a.ts', oldString: 'const a = 1', newString: 'const b = 2' },
    })

    expect(dictatedContentOf(call)).toBe('const b = 2')
  })

  it('claims nothing for a call that dictates no file content', () => {
    expect(dictatedContentOf(aCall({ name: 'bash', input: { command: 'ls' } }))).toBeUndefined()
    expect(dictatedContentOf(aCall({ name: 'edit', input: { path: '/repo/a.ts' } }))).toBeUndefined()
  })
})
