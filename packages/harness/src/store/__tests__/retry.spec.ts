import { describe, expect, it } from 'bun:test'

import { isWriteConflict, retryOnWriteConflict } from '../retry'

const conflict = (): Error => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })

describe('isWriteConflict', () => {
  it('recognises the codes another writer produces', () => {
    expect(isWriteConflict(conflict())).toBe(true)
    expect(isWriteConflict(Object.assign(new Error('timed out'), { code: 'P2024' }))).toBe(true)
    expect(isWriteConflict(new Error('SQLITE_BUSY: database is locked'))).toBe(true)
  })

  it('does not swallow an unrelated failure', () => {
    expect(isWriteConflict(new Error('body is not valid json'))).toBe(false)
    expect(isWriteConflict(Object.assign(new Error('not found'), { code: 'P2025' }))).toBe(false)
    expect(isWriteConflict(undefined)).toBe(false)
  })
})

describe('retryOnWriteConflict', () => {
  it('runs once when nothing conflicts', async () => {
    let calls = 0
    const result = await retryOnWriteConflict({
      run: async () => {
        calls += 1
        return 'done'
      },
    })

    expect(result).toBe('done')
    expect(calls).toBe(1)
  })

  it('retries until the conflict clears', async () => {
    let calls = 0
    const result = await retryOnWriteConflict({
      run: async () => {
        calls += 1
        if (calls < 3) throw conflict()
        return calls
      },
    })

    expect(result).toBe(3)
  })

  it('gives up after the last attempt and rethrows', async () => {
    let calls = 0
    await expect(
      retryOnWriteConflict({
        attempts: 3,
        run: async () => {
          calls += 1
          throw conflict()
        },
      }),
    ).rejects.toThrow('Unique constraint failed')
    expect(calls).toBe(3)
  })

  it('rethrows anything that is not a write conflict immediately', async () => {
    let calls = 0
    await expect(
      retryOnWriteConflict({
        run: async () => {
          calls += 1
          throw new Error('body is not valid json')
        },
      }),
    ).rejects.toThrow('body is not valid json')
    expect(calls).toBe(1)
  })
})
