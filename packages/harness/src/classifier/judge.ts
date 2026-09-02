import { generateText, type LanguageModel } from 'ai'

import {
  EConsultation,
  JudgePort,
  parseVerdict,
  type Brief,
  type Consultation,
} from '@dltech/atlas-core'

export const JUDGE_TIMEOUT_MS = 4000

const JUDGE_OUTPUT_TOKEN_LIMIT = 256

const RETRIES_BELONG_TO_THE_POLICY = 0


const messageOf = (fault: unknown): string =>
  fault instanceof Error ? fault.message : String(fault)

export type HaikuJudgeDeps = {
  model: LanguageModel
  timeoutMs?: number | undefined
  now?: (() => number) | undefined
}

export class HaikuJudge extends JudgePort {
  private readonly model: LanguageModel
  private readonly timeoutMs: number
  private readonly now: () => number

  constructor(deps: HaikuJudgeDeps) {
    super()
    this.model = deps.model
    this.timeoutMs = deps.timeoutMs ?? JUDGE_TIMEOUT_MS
    this.now = deps.now ?? (() => Date.now())
  }

  async consult({ brief, signal }: { brief: Brief; signal: AbortSignal }): Promise<Consultation> {
    const started = this.now()

    try {
      const generated = await generateText({
        model: this.model,
        system: brief.system,
        prompt: brief.prompt,
        maxOutputTokens: JUDGE_OUTPUT_TOKEN_LIMIT,
        maxRetries: RETRIES_BELONG_TO_THE_POLICY,
        abortSignal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
      })

      const reading = parseVerdict({ text: generated.text, targets: brief.targets })

      return {
        kind: EConsultation.Judged,
        verdict: reading.verdict,
        elapsedMs: this.now() - started,
        ...(reading.fault === undefined ? {} : { fault: reading.fault }),
      }
    } catch (fault) {
      return { kind: EConsultation.Unreachable, fault: messageOf(fault) }
    }
  }
}
