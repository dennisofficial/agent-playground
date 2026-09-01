export const HOOK_BUDGET_MS = 5_000

export type HookMishapKind = 'threw' | 'overran' | 'returned-nothing'

export type HookMishap = { label: string; kind: HookMishapKind; detail: string }

export type OnHookMishap = (mishap: HookMishap) => void

const detailOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

type Settled<T> = { value: T } | { mishap: HookMishap }

/**
 * The abandoned promise keeps its handlers, so a hook that rejects long after its budget expired
 * settles into nothing rather than surfacing as an unhandled rejection.
 */
function raceBudget<T>(args: {
  label: string
  attempt: Promise<Settled<T>>
  budgetMs: number
}): Promise<Settled<T>> {
  return new Promise((resolve) => {
    const expiry = setTimeout(
      () => resolve({ mishap: { label: args.label, kind: 'overran', detail: `exceeded ${args.budgetMs}ms` } }),
      args.budgetMs,
    )
    expiry.unref?.()

    const settle = (settled: Settled<T>): void => {
      clearTimeout(expiry)
      resolve(settled)
    }

    args.attempt.then(settle).catch(() => {})
  })
}

export async function withinBudget<T>(args: {
  label: string
  run: () => Promise<T>
  fallback: (mishap: HookMishap) => T
  budgetMs?: number | undefined
  onMishap?: OnHookMishap | undefined
}): Promise<T> {
  const attempt = (async (): Promise<Settled<T>> => {
    try {
      const value = await args.run()
      if (value === undefined) {
        return { mishap: { label: args.label, kind: 'returned-nothing', detail: 'returned undefined' } }
      }
      return { value }
    } catch (error) {
      return { mishap: { label: args.label, kind: 'threw', detail: detailOf(error) } }
    }
  })()

  const settled = await raceBudget({
    label: args.label,
    attempt,
    budgetMs: args.budgetMs ?? HOOK_BUDGET_MS,
  })

  if ('value' in settled) return settled.value

  args.onMishap?.(settled.mishap)
  return args.fallback(settled.mishap)
}
