import { useSyncExternalStore } from 'react'

const SHIMMER_FRAME_MS = 40

type Listener = () => void

type Ticker = {
  subscribe: (listener: Listener) => () => void
  getSnapshot: () => number
}

const tickers = new Map<number, Ticker>()

function createTicker(intervalMs: number): Ticker {
  const listeners = new Set<Listener>()
  let now = Date.now()
  let timer: ReturnType<typeof setInterval> | null = null

  const tick = (): void => {
    now = Date.now()
    for (const listener of listeners) listener()
  }

  const stop = (): void => {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener)
      timer ??= setInterval(tick, intervalMs)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stop()
      }
    },
    getSnapshot: () => now,
  }
}

function tickerFor(intervalMs: number): Ticker {
  const held = tickers.get(intervalMs)
  if (held !== undefined) return held
  const created = createTicker(intervalMs)
  tickers.set(intervalMs, created)
  return created
}

const STILL = Date.now()

const IDLE: Ticker = {
  subscribe: () => () => undefined,
  getSnapshot: () => STILL,
}

export function useShimmerClock(args: { active: boolean; intervalMs?: number }): number {
  const ticker = args.active ? tickerFor(args.intervalMs ?? SHIMMER_FRAME_MS) : IDLE
  return useSyncExternalStore(ticker.subscribe, ticker.getSnapshot)
}
