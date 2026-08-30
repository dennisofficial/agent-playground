import type { ScrollBoxRenderable } from '@opentui/core'

/**
 * OpenTUI 0.4.5's ScrollBoxRenderable emits nothing when it moves: the wheel, a drag, a keypress
 * and sticky-scroll chasing new output all reach `scrollTop` without passing through an event or
 * React. Every one of them lands on the vertical scrollbar's `scrollPosition`, `scrollSize` or
 * `viewportSize` setter, so wrapping those three covers the whole surface exactly, where a poll is
 * only ever eventually right.
 */
const MOVED_BY: readonly string[] = ['scrollPosition', 'scrollSize', 'viewportSize']

function inheritedAccessor(target: object, key: string): PropertyDescriptor | null {
  let level: object | null = Object.getPrototypeOf(target)

  while (level !== null) {
    const found = Object.getOwnPropertyDescriptor(level, key)
    if (found !== undefined) return found
    level = Object.getPrototypeOf(level)
  }

  return null
}

function watchAccessor(args: { target: object; key: string; onChange: () => void }): () => void {
  const inherited = inheritedAccessor(args.target, args.key)
  const read = inherited?.get
  const write = inherited?.set
  if (read === undefined || write === undefined) return () => {}

  Object.defineProperty(args.target, args.key, {
    configurable: true,
    enumerable: false,
    get(this: object): unknown {
      return read.call(this)
    },
    set(this: object, value: unknown) {
      const before = read.call(this)
      write.call(this, value)
      if (read.call(this) !== before) args.onChange()
    },
  })

  return () => {
    Reflect.deleteProperty(args.target, args.key)
  }
}

/**
 * A frame of sticky scroll writes the content height, the viewport height and the corrected
 * position one after another, so the intermediate reads say the transcript has fallen off the end
 * when it has not. Coalescing to a microtask reports the settled state instead of the flicker.
 */
export function observeScroll(box: ScrollBoxRenderable, onChange: () => void): () => void {
  let queued = false

  const schedule = (): void => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      onChange()
    })
  }

  const released = MOVED_BY.map((key) =>
    watchAccessor({ target: box.verticalScrollBar, key, onChange: schedule }),
  )

  return () => {
    for (const release of released) release()
  }
}
