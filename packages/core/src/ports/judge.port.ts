import type { Consultation } from '../policy/classifier/adjudicate'

export type Brief = { system: string; prompt: string; targets: readonly string[] }

export abstract class JudgePort {
  abstract consult(args: { brief: Brief; signal: AbortSignal }): Promise<Consultation>
}
