import { ESandboxState, type SandboxStatus } from '@dltech/atlas-harness'

import type { SidebarContainer, SidebarLimits } from '../store/sidebar-model'

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
      return { ...held, state: status.state, ports: status.ports }
    case ESandboxState.Stopped:
      return { ...held, state: status.state }
    case ESandboxState.Failed:
      return { ...held, state: status.state, reason: status.reason }
  }
}

export function createSandboxStatusState(args: {
  image: string
  label: string
  limits?: SidebarLimits | undefined
}): SandboxStatusState {
  let held: SidebarContainer = {
    state: ESandboxState.Stopped,
    image: args.image,
    label: args.label,
    ...(args.limits === undefined ? {} : { limits: args.limits }),
    ports: [],
  }
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
