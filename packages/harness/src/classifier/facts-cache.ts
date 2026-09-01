export enum EFactScope {
  Session = 'session',
  Turn = 'turn',
  Brief = 'brief',
}

export const DIRTINESS_TTL_MS = 5_000

type Held<TValue> = { storedAt: number; value: Promise<TValue> }

export class FactSlots<TValue> {
  private readonly held = new Map<string, Held<TValue>>()
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(args: { now: () => number; ttlMs: number }) {
    this.now = args.now
    this.ttlMs = args.ttlMs
  }

  read(args: { key: string; collect: () => Promise<TValue> }): Promise<TValue> {
    const standing = this.held.get(args.key)
    if (standing !== undefined && this.now() - standing.storedAt < this.ttlMs) {
      return standing.value
    }

    const value = args.collect()
    this.held.set(args.key, { storedAt: this.now(), value })
    void value.catch(() => {
      if (this.held.get(args.key)?.value === value) this.held.delete(args.key)
    })

    return value
  }

  clear(): void {
    this.held.clear()
  }
}

export class FactsCache {
  private readonly registered: { scope: EFactScope; clear: () => void }[] = []
  private readonly now: () => number
  private readonly briefTtlMs: number

  constructor(args: { now: () => number; briefTtlMs?: number | undefined }) {
    this.now = args.now
    this.briefTtlMs = args.briefTtlMs ?? DIRTINESS_TTL_MS
  }

  slots<TValue>(args: { scope: EFactScope }): FactSlots<TValue> {
    const ttlMs = args.scope === EFactScope.Brief ? this.briefTtlMs : Number.POSITIVE_INFINITY
    const created = new FactSlots<TValue>({ now: this.now, ttlMs })
    this.registered.push({ scope: args.scope, clear: () => created.clear() })

    return created
  }

  expire(args: { scope: EFactScope }): void {
    for (const slots of this.registered) {
      if (slots.scope === args.scope) slots.clear()
    }
  }

  expireAll(): void {
    for (const slots of this.registered) slots.clear()
  }
}
