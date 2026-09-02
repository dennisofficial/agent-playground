import { z } from 'zod'

import type { ERiskDimension } from './dimension'
import type { CallEvidence } from './evidence'
import { callEvidenceSchema } from './evidence-schema'
import { signalsFor, type SignalProbe } from './signals'
import { DEFAULT_CLASSIFIER_POLICY, ETriage, triageOf, type ClassifierPolicy } from './triage'

export type CorpusFile = { expect: ETriage; note: string; evidence: CallEvidence }

export type CorpusCase = CorpusFile & { name: string }

export type CorpusVerdict = {
  name: string
  note: string
  expected: ETriage
  actual: ETriage
  agrees: boolean
  dimensions: readonly ERiskDimension[]
}

const corpusFileSchema = z.object({
  expect: z.enum(ETriage),
  note: z.string().default(''),
  evidence: callEvidenceSchema,
})

export function corpusCaseFrom({ name, json }: { name: string; json: unknown }): CorpusCase {
  const parsed = corpusFileSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(`${name} is not a classifier corpus case: ${parsed.error.message}`)
  }

  return { name, ...parsed.data }
}

export function checkCorpusCase({
  entry,
  policy,
  probes,
}: {
  entry: CorpusCase
  policy?: ClassifierPolicy | undefined
  probes?: readonly SignalProbe[] | undefined
}): CorpusVerdict {
  const evidence = entry.evidence
  const triage = triageOf({
    evidence,
    signals: signalsFor({ evidence, probes }),
    policy: policy ?? DEFAULT_CLASSIFIER_POLICY,
    asksSoFar: 0,
  })

  return {
    name: entry.name,
    note: entry.note,
    expected: entry.expect,
    actual: triage.triage,
    agrees: triage.triage === entry.expect,
    dimensions: [...new Set(triage.standing.map((signal) => signal.dimension))],
  }
}
