import { resolve } from 'node:path'

const tails = new Map<string, Promise<void>>()

export async function withPathLock<T>({
  path,
  run,
}: {
  path: string
  run: () => Promise<T>
}): Promise<T> {
  const key = resolve(path)
  const ahead = tails.get(key)

  let release = (): void => undefined
  const mine = new Promise<void>((done) => {
    release = done
  })
  tails.set(key, mine)

  if (ahead !== undefined) await ahead

  try {
    return await run()
  } finally {
    release()
    if (tails.get(key) === mine) tails.delete(key)
  }
}

export const pathsHeld = (): number => tails.size
