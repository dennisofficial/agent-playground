import { ECommandKind, type CommandSpec } from '@dltech/atlas-core'

export enum ECommandTiming {
  Immediate = 'immediate',
  Settled = 'settled',
}

export enum ECommandEcho {
  Silent = 'silent',
  Name = 'name',
  Output = 'output',
}

export enum ECommandEffect {
  Ran = 'ran',
  Refused = 'refused',
  Nothing = 'nothing',
}

export type CommandEffect =
  | { type: ECommandEffect.Ran; notice?: string | undefined }
  | { type: ECommandEffect.Refused; reason: string }
  | { type: ECommandEffect.Nothing }

export type LocalCommand = CommandSpec & {
  kind: ECommandKind.Local
  timing: ECommandTiming
  echo: ECommandEcho
  /** True when running it strands whatever else was queued: it swaps the thread out or the process. */
  dropsQueue?: boolean
  run: (args: { argumentText: string }) => CommandEffect | Promise<CommandEffect>
}

export const RAN: CommandEffect = { type: ECommandEffect.Ran }
export const NOTHING: CommandEffect = { type: ECommandEffect.Nothing }
