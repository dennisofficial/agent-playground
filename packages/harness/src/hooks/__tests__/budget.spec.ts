import { describe, expect, it } from 'bun:test'

import { withinBudget, type HookMishap } from '../budget'

const collect = (): { seen: HookMishap[]; onMishap: (mishap: HookMishap) => void } => {
  const seen: HookMishap[] = []
  return { seen, onMishap: (mishap) => seen.push(mishap) }
}

const never = <T>(): Promise<T> => new Promise<T>(() => {})

describe('withinBudget', () => {
  it('returns what the hook returned when it settles in time', async () => {
    const { seen, onMishap } = collect()

    const value = await withinBudget({
      label: 'quick',
      run: async () => 'settled',
      fallback: () => 'fallback',
      onMishap,
    })

    expect(value).toBe('settled')
    expect(seen).toEqual([])
  })

  it('falls back and reports when the hook throws', async () => {
    const { seen, onMishap } = collect()

    const value = await withinBudget({
      label: 'thrower',
      run: async () => {
        throw new Error('boom')
      },
      fallback: () => 'fallback',
      onMishap,
    })

    expect(value).toBe('fallback')
    expect(seen).toEqual([{ label: 'thrower', kind: 'threw', detail: 'boom' }])
  })

  it('falls back and reports when the hook outlives its budget', async () => {
    const { seen, onMishap } = collect()

    const value = await withinBudget({
      label: 'hanger',
      run: never<string>,
      fallback: () => 'fallback',
      budgetMs: 5,
      onMishap,
    })

    expect(value).toBe('fallback')
    expect(seen).toEqual([{ label: 'hanger', kind: 'overran', detail: 'exceeded 5ms' }])
  })

  it('falls back and reports when the hook returns undefined', async () => {
    const { seen, onMishap } = collect()

    const value = await withinBudget({
      label: 'forgetful',
      run: async () => undefined as unknown as string,
      fallback: () => 'fallback',
      onMishap,
    })

    expect(value).toBe('fallback')
    expect(seen).toEqual([{ label: 'forgetful', kind: 'returned-nothing', detail: 'returned undefined' }])
  })

  it('passes null through, because a chunk hook drops with it', async () => {
    const { seen, onMishap } = collect()

    const value = await withinBudget<string | null>({
      label: 'dropper',
      run: async () => null,
      fallback: () => 'fallback',
      onMishap,
    })

    expect(value).toBeNull()
    expect(seen).toEqual([])
  })

  it('reports once, not twice, when a hook rejects long after its budget expired', async () => {
    const { seen, onMishap } = collect()
    let reject: (error: Error) => void = () => {}

    const value = await withinBudget({
      label: 'late',
      run: () =>
        new Promise<string>((unused, fail) => {
          reject = fail
        }),
      fallback: () => 'fallback',
      budgetMs: 5,
      onMishap,
    })

    expect(value).toBe('fallback')

    reject(new Error('too late to matter'))
    await Bun.sleep(10)

    expect(seen).toEqual([{ label: 'late', kind: 'overran', detail: 'exceeded 5ms' }])
  })

  it('is usable with no reporter', async () => {
    expect(
      await withinBudget({ label: 'quiet', run: never<string>, fallback: () => 'fallback', budgetMs: 5 }),
    ).toBe('fallback')
  })
})
