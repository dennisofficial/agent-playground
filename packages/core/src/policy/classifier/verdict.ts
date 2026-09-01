import type { ERiskDimension } from './dimension'
import type { RiskSignal } from './signals'

export enum EJudgment {
  Proceed = 'proceed',
  Check = 'check',
}

export type Verdict = { judgment: EJudgment; reason: string }

const CLOSED_THINKING = /<thinking\b[^>]*>[\s\S]*?<\/thinking\s*>/gi
const UNCLOSED_THINKING = /<thinking\b[^>]*>[\s\S]*$/i
const VERDICT = /<verdict\s*>\s*(proceed|check)\s*<\/verdict\s*>/i
const REASON = /<reason\s*>([\s\S]*?)<\/reason\s*>/i

const REASON_LIMIT = 300

const collapsed = (text: string): string => text.replace(/\s+/g, ' ').trim()

const clipped = (text: string): string =>
  text.length <= REASON_LIMIT ? text : `${text.slice(0, REASON_LIMIT - 1)}…`

export function withoutThinking({ text }: { text: string }): string {
  return text.replace(CLOSED_THINKING, ' ').replace(UNCLOSED_THINKING, ' ')
}

const spellingsOf = ({ subject }: { subject: string }): readonly string[] => {
  const divider = subject.indexOf(':')
  const value = divider === -1 ? subject : subject.slice(divider + 1)
  const leaf = value
    .split('/')
    .filter((segment) => segment.length > 0)
    .at(-1)

  return [subject, value, leaf ?? ''].filter((spelling) => spelling.length > 0)
}

export function namingTargetsOf({
  standing,
}: {
  standing: readonly RiskSignal[]
}): readonly string[] {
  const targets = new Set<string>()
  for (const signal of standing) {
    for (const spelling of spellingsOf({ subject: signal.subject })) targets.add(spelling)
  }
  return [...targets]
}

const names = ({ reason, target }: { reason: string; target: string }): boolean =>
  reason.toLowerCase().includes(target.toLowerCase())

export function parseVerdict({
  text,
  targets,
}: {
  text: string
  targets: readonly string[]
}): Verdict | undefined {
  const spoken = withoutThinking({ text })
  const declared = spoken.match(VERDICT)?.[1]?.toLowerCase()
  if (declared === undefined) return undefined

  const reason = clipped(collapsed(spoken.match(REASON)?.[1] ?? ''))
  if (declared === EJudgment.Proceed) return { judgment: EJudgment.Proceed, reason }

  if (reason.length === 0) return undefined
  if (!targets.some((target) => names({ reason, target }))) return undefined

  return { judgment: EJudgment.Check, reason }
}

const labelsOf = ({ dimension }: { dimension: ERiskDimension }): readonly string[] => [
  dimension,
  dimension.replaceAll('-', ' '),
]

export function dimensionCitedIn({
  reason,
  standing,
}: {
  reason: string
  standing: readonly RiskSignal[]
}): ERiskDimension | undefined {
  const named = standing.find((signal) =>
    labelsOf({ dimension: signal.dimension }).some((label) => names({ reason, target: label })),
  )
  if (named !== undefined) return named.dimension

  return standing.find((signal) =>
    spellingsOf({ subject: signal.subject }).some((target) => names({ reason, target })),
  )?.dimension
}
