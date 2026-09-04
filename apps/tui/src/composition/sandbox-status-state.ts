import { ESandboxState, type SandboxStatus } from '@dltech/atlas-harness'

import type { SidebarContainer } from '../store/sidebar-model'

export type SandboxStatusState = {
  current: () => SidebarContainer
  mark: (status: SandboxStatus) => void
  subscribe: (listener: () => void) => () => void
}

const merged = (args: {
  held: SidebarContainer
  status: SandboxStatus
}): SidebarContainer => {
  const { held, status } = args
  switch (status.state) {
    case ESandboxState.Starting:
      return { ...held, state: status.state }
    case ESandboxState.Running:
      return { state: status.state, image: held.image, ports: status.ports }
    case ESandboxState.Stopped:
      return { ...held, state: status.state }
    case ESandboxState.Failed:
      return { ...held, state: status.state, reason: status.reason }
  }
}

export function createSandboxStatusState(args: { image: string }): SandboxStatusState {
  let held: SidebarContainer = { state: ESandboxState.Stopped, image: args.image, ports: [] }
  const listeners = new Set<() => void>()

  return {
    current: () => held,
    mark: (status) => {
      held = merged({ held, status })
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
