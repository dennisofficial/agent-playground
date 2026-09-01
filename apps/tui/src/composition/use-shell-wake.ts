import type { ThreadId } from '@dltech/atlas-core'
import type { ShellRegistryPort, ShellSnapshot } from '@dltech/atlas-harness'
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

/**
 * A background shell that ends while nothing is running has no turn to be delivered into, so the
 * ending is what starts one. Mid-turn there is nothing to do: the loop drains the same queue on its
 * next pass. The witness keeps a turn that dies before its first drain from spinning here.
 *
 * A turn must not start behind a prompt that has taken the keyboard, so an overlay waiting on an
 * answer holds the wake off until it is closed. The ending keeps until then.
 *
 * Only this thread's endings are read, and only this thread is woken: a shell belongs to whoever
 * started it.
 */
export function useShellWake(args: {
  shells: ShellRegistryPort
  threadId: ThreadId
  working: boolean
  canWake: boolean
  onWake: () => void
}): readonly ShellSnapshot[] {
  const { shells, threadId, working, canWake, onWake } = args

  const subscribe = useCallback((listener: () => void) => shells.onNotice(listener), [shells])
  const read = useCallback(() => shells.pendingNotices({ threadId }), [shells, threadId])
  const notices = useSyncExternalStore(subscribe, read)

  const woken = useRef<string | null>(null)

  useEffect(() => {
    if (notices.length === 0) {
      woken.current = null
      return
    }
    if (working || !canWake) return

    const witness = notices.map((notice) => notice.shellId).join(' ')
    if (woken.current === witness) return

    woken.current = witness
    onWake()
  }, [canWake, notices, onWake, working])

  return notices
}
