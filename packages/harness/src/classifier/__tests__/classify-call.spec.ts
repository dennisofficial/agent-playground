import { describe, expect, it } from 'bun:test'

import {
  EBeforeToolDecision,
  EClassifierMode,
  EDecision,
  EJudgment,
  EStage,
  ERiskDimension,
  ETriage,
  RISK_PROBES,
  stampDrafts,
  toCallId,
  toEventId,
  toRunId,
  toThreadId,
  type Event,
  type EventDraft,
} from '@dltech/atlas-core'

import {
  callTo,
  classify,
  factsInAWorktree,
  hookOver,
  OURS,
  policyIn,
  RecordingFacts,
  REPO,
  SIBLING,
} from './fixtures'

const stamped = (drafts: readonly EventDraft[]): readonly Event[] =>
  stampDrafts({
    drafts,
    envelopes: drafts.map((_, index) => ({
      id: toEventId(`evt-${index + 1}`),
      seq: index + 1,
      threadId: toThreadId('thread-1'),
      runId: toRunId('run-1'),
      depth: 0,
      at: '2026-09-01T00:00:00.000Z',
    })),
  })

const judgedIn = (outcome: { drafts?: readonly EventDraft[] | undefined }) => {
  const draft = (outcome.drafts ?? []).find((one) => one.type === 'classifier-judged')
  if (draft?.type !== 'classifier-judged') throw new Error('no classifier-judged draft was written')
  return draft
}

describe('the calls phase A clears without touching the workspace', () => {
  const cleared = [
    { what: 'a read inside the project', call: callTo({ name: 'read', input: { path: `${OURS}/src/a.ts` } }) },
    { what: 'a grep naming no path', call: callTo({ name: 'grep', input: { pattern: 'assemble' } }) },
    { what: 'an edit inside the project', call: callTo({ name: 'edit', input: { path: `${OURS}/src/a.ts`, text: 'x' } }) },
    { what: 'a bash test run', call: callTo({ name: 'bash', input: { command: 'bun test' } }) },
  ]

  for (const { what, call } of cleared) {
    it(`allows ${what} with no row and no git`, async () => {
      const facts = new RecordingFacts(factsInAWorktree())
      const outcome = await classify({ hook: hookOver({ facts }), call })

      expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
      expect(outcome.drafts ?? []).toEqual([])
      expect(facts.requests).toEqual([])
    })
  }

  it('clears a call the operator has already answered rather than weighing it twice', async () => {
    const facts = new RecordingFacts(factsInAWorktree())
    const events = stamped([
      { type: 'approval-answered', callId: toCallId('call-1'), decision: EDecision.Allow },
    ])

    const outcome = await classify({
      hook: hookOver({ facts }),
      call: callTo({ name: 'bash', input: { command: `rm -rf ${SIBLING}` } }),
      events,
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
    expect(outcome.drafts ?? []).toEqual([])
    expect(facts.requests).toEqual([])
  })

  it('does not clear a write that lands inside another agent’s worktree', async () => {
    const facts = new RecordingFacts(factsInAWorktree())

    await classify({
      hook: hookOver({ facts }),
      call: callTo({ name: 'edit', input: { path: `${SIBLING}/src/a.ts`, text: 'x' } }),
    })

    expect(facts.requests).toHaveLength(1)
  })
})

describe('a call that trips a probe, in shadow', () => {
  const removingASiblingWorktree = () =>
    classify({
      hook: hookOver({ facts: new RecordingFacts(factsInAWorktree()) }),
      call: callTo({ name: 'bash', input: { command: `git worktree remove --force ${SIBLING}` } }),
    })

  it('still allows the call', async () => {
    expect((await removingASiblingWorktree()).decision).toBe(EBeforeToolDecision.Allow)
  })

  it('records a consult naming contention, because the sibling carries uncommitted work', async () => {
    const judged = judgedIn(await removingASiblingWorktree())

    expect(judged.triage).toBe(ETriage.Consult)
    expect(judged.mode).toBe(EClassifierMode.Shadow)
    expect(judged.dimensions).toContain(ERiskDimension.Contention)
    expect(judged.reason).toContain(SIBLING)
  })

  it('leaves the row unconsulted while no judge is bound', async () => {
    const judged = judgedIn(await removingASiblingWorktree())

    expect(judged.consulted).toBe(false)
  })

  it('records what a bound judge answered, and still lets the call run', async () => {
    const outcome = await classify({
      hook: hookOver({
        facts: new RecordingFacts(factsInAWorktree()),
        judge: async () => ({
          judgment: EJudgment.Check,
          reason: `contention: ${SIBLING} carries uncommitted work`,
        }),
      }),
      call: callTo({ name: 'bash', input: { command: `git worktree remove --force ${SIBLING}` } }),
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
    expect(judgedIn(outcome).consulted).toBe(true)
    expect(judgedIn(outcome).judgment).toBe(EJudgment.Check)
  })

  it('asks the workspace only for the realms the deed names', async () => {
    const facts = new RecordingFacts(factsInAWorktree())
    await classify({
      hook: hookOver({ facts }),
      call: callTo({ name: 'bash', input: { command: `git worktree remove --force ${SIBLING}` } }),
    })

    const request = facts.requests[0]
    expect(request?.projectDirectory).toBe(OURS)
    expect(request?.launchDirectory).toBe(REPO)
    expect(request?.targets.map((target) => target.value)).toContain(SIBLING)
  })
})

describe('the classifier when the world will not answer', () => {
  it('allows, and lets the probes that needed the workspace go quiet, when the facts reject', async () => {
    const facts = new RecordingFacts(new Error('git is not here'))
    const outcome = await classify({
      hook: hookOver({ facts }),
      call: callTo({ name: 'bash', input: { command: `git worktree remove --force ${SIBLING}` } }),
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
    expect(judgedIn(outcome).dimensions).not.toContain(ERiskDimension.Contention)
    expect(judgedIn(outcome).dimensions).toContain(ERiskDimension.Irreversibility)
  })

  it('allows, and records the fault, when the classifier itself throws', async () => {
    const outcome = await classify({
      hook: hookOver({
        facts: new RecordingFacts(factsInAWorktree()),
        judge: async () => {
          throw new Error('the judge exploded')
        },
      }),
      call: callTo({ name: 'bash', input: { command: `git worktree remove --force ${SIBLING}` } }),
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
    expect(judgedIn(outcome).signalIds).toEqual(['classifier:fault'])
    expect(judgedIn(outcome).reason).toContain('the judge exploded')
  })

  it('allows, and keeps every other probe, when one probe throws', async () => {
    const outcome = await classify({
      hook: hookOver({
        facts: new RecordingFacts(factsInAWorktree()),
        probes: [
          {
            dimension: ERiskDimension.Blast,
            probe: () => {
              throw new Error('this probe is broken')
            },
          },
          ...RISK_PROBES,
        ],
      }),
      call: callTo({ name: 'bash', input: { command: `git worktree remove --force ${SIBLING}` } }),
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
    expect(judgedIn(outcome).dimensions).toContain(ERiskDimension.Contention)
  })
})

describe('the classifier turned off', () => {
  it('writes no row and reads no workspace', async () => {
    const facts = new RecordingFacts(factsInAWorktree())
    const outcome = await classify({
      hook: hookOver({ facts, policy: policyIn(EClassifierMode.Off) }),
      call: callTo({ name: 'bash', input: { command: `git worktree remove --force ${SIBLING}` } }),
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
    expect(outcome.drafts ?? []).toEqual([])
    expect(facts.requests).toEqual([])
  })
})

describe('where the hook sits in the chain', () => {
  it('runs in the policy stage, after every guard has settled the input', () => {
    const hook = hookOver({ facts: new RecordingFacts() })

    expect(hook.name).toBe('classifyCall')
    expect(hook.order).toEqual({ stage: EStage.Policy, nudge: 0 })
  })
})
