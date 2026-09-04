import type { ThreadId } from '../events/ids'

export type SpawnCommand = {
  readonly cmd: readonly string[]
  readonly cwd: string
  readonly env?: Record<string, string | undefined> | undefined
  readonly threadId?: ThreadId | undefined
}

export type ProcessHandle = {
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  terminate(): void
}

export type PortExposure = {
  readonly containerPort: number
  readonly hostPort: number
  readonly url: string
}

export type PortExposureOutcome =
  | { ok: true; exposure: PortExposure }
  | { ok: false; reason: string }

export abstract class ProcessPort {
  abstract spawn(args: SpawnCommand): ProcessHandle

  abstract which(args: { command: string; threadId?: ThreadId | undefined }): string | null

  exposePort?(args: {
    containerPort: number
    threadId?: ThreadId | undefined
  }): Promise<PortExposureOutcome>
}
