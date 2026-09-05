import type { Unsubscribe } from '@dltech/atlas-harness'

import type { SidebarContainer } from './sidebar-model'

export type SandboxStatusSource = {
  current: () => SidebarContainer
  subscribe: (listener: () => void) => Unsubscribe
}

const sameSandbox = (left: SidebarContainer | null, right: SidebarContainer | null): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.state === right.state &&
    left.image === right.image &&
    left.reason === right.reason)

export function watchSandbox(args: {
  source: SandboxStatusSource | undefined
  current: () => SidebarContainer | null
  onMoved: (next: SidebarContainer | null) => void
}): Unsubscribe | undefined {
  const { source } = args
  if (source === undefined) return undefined

  return source.subscribe(() => {
    const next = source.current()
    if (sameSandbox(args.current(), next)) return

    args.onMoved(next)
  })
}
