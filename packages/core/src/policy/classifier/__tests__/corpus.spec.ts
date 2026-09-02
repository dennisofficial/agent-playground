import { describe, expect, it } from 'bun:test'

import { ERiskDimension, ESeverity } from '../dimension'
import { checkCorpusCase, corpusCaseFrom } from '../corpus'
import { riskSignal } from '../probes/kit'
import type { SignalProbe } from '../signals'
import { ETriage } from '../triage'
import { CORPUS_DIRECTORY, readCorpus } from './corpus'
import { REPO, bashEvidence, onMain } from './fixtures'

const aCapturedCase = ({ expect: expectation }: { expect: ETriage }) =>
  corpusCaseFrom({
    name: 'captured.json',
    json: JSON.parse(
      JSON.stringify({
        expect: expectation,
        note: 'the developer hit this once',
        evidence: bashEvidence({ command: 'rm -rf node_modules', facts: onMain() }),
      }),
    ),
  })

const aProbeThatFires: SignalProbe = {
  dimension: ERiskDimension.Blast,
  probe: () => [
    riskSignal({
      dimension: ERiskDimension.Blast,
      severity: ESeverity.Serious,
      id: 'blast:new-rule',
      subject: `path:${REPO}`,
      detail: 'a probe change made this call interesting',
    }),
  ],
}

describe('a captured case', () => {
  it('round-trips through JSON and still reads as the call it captured', () => {
    const entry = aCapturedCase({ expect: ETriage.Clear })

    expect(entry.evidence.toolName).toBe('bash')
    expect(entry.evidence.deeds[0]?.targets[0]?.value).toBe(`${REPO}/node_modules`)
    expect(entry.evidence.reading?.segments[0]?.verb).toBeUndefined()
    expect(checkCorpusCase({ entry }).agrees).toBe(true)
  })

  it('fails the suite when a probe change turns its Clear into a Consult', () => {
    const verdict = checkCorpusCase({
      entry: aCapturedCase({ expect: ETriage.Clear }),
      probes: [aProbeThatFires],
    })

    expect(verdict.agrees).toBe(false)
    expect(verdict.actual).toBe(ETriage.Consult)
    expect(verdict.dimensions).toEqual([ERiskDimension.Blast])
  })

  it('refuses a file that is not a case at all, naming it', () => {
    expect(() => corpusCaseFrom({ name: 'junk.json', json: { expect: 'maybe' } })).toThrow(
      'junk.json',
    )
  })
})

describe('the corpus checked into the test tree', () => {
  it('holds cases on both sides of the triage', () => {
    const expectations = readCorpus({ directory: CORPUS_DIRECTORY }).map((entry) => entry.expect)

    expect(expectations).toContain(ETriage.Clear)
    expect(expectations).toContain(ETriage.Consult)
  })
})
