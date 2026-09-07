import type { BoundPort } from './ports'

export enum ESandboxState {
  Starting = 'starting',
  Running = 'running',
  Stopped = 'stopped',
  Failed = 'failed',
}

export type SandboxStatus =
  | { state: ESandboxState.Starting }
  | { state: ESandboxState.Running; name: string; ports: readonly BoundPort[] }
  | { state: ESandboxState.Stopped }
  | { state: ESandboxState.Failed; reason: string }

export type SandboxStatusListener = (status: SandboxStatus) => void
