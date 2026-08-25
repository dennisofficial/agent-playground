const RETRYABLE_PRISMA_CODES = new Set(['P2002', 'P2024', 'P2034'])
const RETRYABLE_SQLITE_MESSAGES = ['SQLITE_BUSY', 'database is locked', 'database table is locked']
const DEFAULT_ATTEMPTS = 12
const BACK_OFF_CEILING_MS = 64

export async function retryOnWriteConflict<TResult>({
  run,
  attempts = DEFAULT_ATTEMPTS,
}: {
  run: () => Promise<TResult>
  attempts?: number
}): Promise<TResult> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      if (attempt >= attempts || !isWriteConflict(error)) throw error
      await backOff(attempt)
    }
  }
}

export function isWriteConflict(error: unknown): boolean {
  const code = codeOf(error)
  if (code !== undefined && RETRYABLE_PRISMA_CODES.has(code)) return true
  return RETRYABLE_SQLITE_MESSAGES.some((fragment) => messageOf(error).includes(fragment))
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function messageOf(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('message' in error)) return ''
  return typeof error.message === 'string' ? error.message : ''
}

function backOff(attempt: number): Promise<void> {
  const ceiling = Math.min(2 ** attempt, BACK_OFF_CEILING_MS)
  return new Promise((resolve) => setTimeout(resolve, Math.random() * ceiling))
}
