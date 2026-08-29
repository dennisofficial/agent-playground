const SECONDS_PER_SUFFIX: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400 }

const SLEEP = /\bsleep\s+(\d+(?:\.\d+)?)\s*([smhd])?\b/g

export const SLEEP_BUDGET_SECONDS = 30

export function sleptSeconds(command: string): number {
  let total = 0
  for (const [, amount, suffix] of command.matchAll(SLEEP)) {
    if (amount === undefined) continue
    total += Number(amount) * (SECONDS_PER_SUFFIX[suffix ?? 's'] ?? 1)
  }
  return total
}

export function waitsBySleeping(command: string): boolean {
  return sleptSeconds(command) > SLEEP_BUDGET_SECONDS
}
