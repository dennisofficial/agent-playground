import React from 'react'

import { CrashScreen } from '../ui/components/crash-screen'

type CrashState = { error: Error | null }

/**
 * @opentui/react wraps the root in a boundary of its own, but its fallback only prints the stack:
 * the keyboard lived in the tree it unmounted, so nothing is left that can quit. This boundary sits
 * inside it and answers with a screen that can copy the error and exit.
 */
export class CrashBoundary extends React.Component<
  { children: React.ReactNode },
  CrashState
> {
  override state: CrashState = { error: null }

  static getDerivedStateFromError(error: Error): CrashState {
    return { error }
  }

  override render(): React.ReactNode {
    if (this.state.error !== null) return <CrashScreen error={this.state.error} />
    return this.props.children
  }
}
