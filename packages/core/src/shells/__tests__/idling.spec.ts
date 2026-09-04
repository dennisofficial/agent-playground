import { describe, expect, it } from 'bun:test'

import {
  SLEEP_BUDGET_SECONDS,
  doesNothing,
  idledSeconds,
  readIdling,
  sleptSeconds,
  waitsBySleeping,
  type IdleReading,
} from '../idling'

const UNBOUNDED_MS = 600_000

const waits = (command: string, timeoutMs = UNBOUNDED_MS): boolean =>
  waitsBySleeping({ command, timeoutMs })

describe('the seconds a command spends asleep', () => {
  it('reads a bare sleep as seconds', () => {
    expect(sleptSeconds('sleep 115')).toBe(115)
  })

  it('reads the suffixes sleep accepts', () => {
    expect(sleptSeconds('sleep 2m')).toBe(120)
    expect(sleptSeconds('sleep 1h')).toBe(3_600)
    expect(sleptSeconds('sleep 1d')).toBe(86_400)
    expect(sleptSeconds('sleep 0.5')).toBe(0.5)
  })

  it('adds up every sleep in a chain', () => {
    expect(sleptSeconds('sleep 20; echo half; sleep 20')).toBe(40)
  })

  it('counts nothing in a command that never sleeps', () => {
    expect(sleptSeconds('bun test')).toBe(0)
  })

  it('does not mistake a longer word for the command', () => {
    expect(sleptSeconds('grep oversleep 30 notes.txt')).toBe(0)
  })
})

describe('telling an idle wait from a short settle', () => {
  it('calls the poll loop that was burning turns a wait', () => {
    expect(waits('sleep 115; echo waited')).toBe(true)
    expect(waits('sleep 90; echo waited')).toBe(true)
  })

  it('leaves a short settle before a real command alone', () => {
    expect(waits('sleep 2 && curl -sf localhost:3000')).toBe(false)
    expect(waits('sleep 5; bun test')).toBe(false)
  })

  it('leaves the budget itself alone and refuses only past it', () => {
    expect(waits(`sleep ${SLEEP_BUDGET_SECONDS}`)).toBe(false)
    expect(waits(`sleep ${SLEEP_BUDGET_SECONDS + 1}`)).toBe(true)
  })

  it('sees a wait split across several short sleeps', () => {
    expect(waits('sleep 20; sleep 20; sleep 20')).toBe(true)
  })
})

describe('a timeout the caller set caps what the command can idle away', () => {
  const BRIEF_MS = 300

  it('allows a long sleep the timeout will cut short well inside the budget', () => {
    expect(waits('(sleep 2; touch marker) & echo working; sleep 30', BRIEF_MS)).toBe(false)
  })

  it('still refuses when the timeout leaves room to idle past the budget', () => {
    expect(waits(`sleep ${SLEEP_BUDGET_SECONDS * 4}`, UNBOUNDED_MS)).toBe(true)
  })

  it('measures the idle as the shorter of the sleeping and the timeout', () => {
    expect(idledSeconds({ command: 'sleep 120', timeoutMs: 5_000 })).toBe(5)
    expect(idledSeconds({ command: 'sleep 3', timeoutMs: UNBOUNDED_MS })).toBe(3)
  })

  it('leaves the budget itself alone when the timeout lands exactly on it', () => {
    expect(waits('sleep 600', SLEEP_BUDGET_SECONDS * 1_000)).toBe(false)
  })
})

describe('reading the loop a sleep sits inside', () => {
  const reads = (command: string, timeoutMs = UNBOUNDED_MS): IdleReading =>
    readIdling({ command, timeoutMs })

  it('multiplies the body sleep by the trip count seq names', () => {
    const reading = reads('for i in $(seq 1 115); do [ -f /tmp/x.done ] && break; sleep 5; done')
    expect(reading.seconds).toBe(575)
    expect(reading.iterations).toBe(115)
    expect(reading.unbounded).toBe(false)
  })

  it('reads a one-argument seq as counting from one', () => {
    expect(reads('for i in $(seq 60); do sleep 20; done', 3_600_000).seconds).toBe(1_200)
  })

  it('reads the step a three-argument seq names', () => {
    expect(reads('for i in $(seq 0 2 10); do sleep 10; done').seconds).toBe(60)
  })

  it('reads a brace range as a trip count', () => {
    expect(reads('for i in {1..10}; do sleep 5; done').seconds).toBe(50)
  })

  it('reads a literal word list as its own length', () => {
    expect(reads('for host in a b c; do ping -c1 $host; sleep 5; done').seconds).toBe(15)
  })

  it('multiplies a nested loop by both trip counts', () => {
    expect(reads('for i in {1..3}; do for j in {1..4}; do sleep 1; done; done').seconds).toBe(12)
  })

  it('adds a sleep outside the loop to the sleeping inside it', () => {
    expect(reads('sleep 7; for i in {1..4}; do sleep 3; done').seconds).toBe(19)
  })

  it('leaves a loop that never sleeps at nothing', () => {
    expect(reads('for f in *.ts; do echo $f; done').seconds).toBe(0)
    expect(reads('for f in *.ts; do echo $f; done').unbounded).toBe(false)
  })

  it('is not closed early by a filename ending in done', () => {
    expect(reads('for i in {1..20}; do [ -f /tmp/x.done ] && break; sleep 2; done').seconds).toBe(
      40,
    )
  })

  it('calls a loop unbounded when a sleep sits in a while true', () => {
    const reading = reads('while true; do gh pr checks 272; sleep 30; done')
    expect(reading.unbounded).toBe(true)
    expect(reading.iterations).toBeUndefined()
  })

  it('calls the other unbounded loop headers unbounded too', () => {
    expect(reads('while :; do sleep 10; done').unbounded).toBe(true)
    expect(reads('until [ -f /tmp/ready ]; do sleep 10; done').unbounded).toBe(true)
  })

  it('calls a trip count it cannot read unbounded', () => {
    expect(reads('for i in $(seq 1 $ATTEMPTS); do sleep 5; done').unbounded).toBe(true)
  })

  it('leaves an unbounded loop that never sleeps alone', () => {
    expect(reads('while read line; do echo $line; done < input.txt').unbounded).toBe(false)
  })

  it('reads an unbounded wait as idling until the timeout cuts it off', () => {
    expect(reads('while true; do sleep 30; done', 120_000).seconds).toBe(120)
  })

  it('caps a bounded loop at the timeout, like a bare sleep', () => {
    expect(reads('for i in {1..100}; do sleep 30; done', 60_000).seconds).toBe(60)
  })

  it('keeps sleptSeconds a single pass, with no loop applied', () => {
    expect(sleptSeconds('for i in $(seq 1 115); do sleep 5; done')).toBe(5)
  })
})

describe('a command that does nothing at all', () => {
  it('calls the bare no-ops nothing', () => {
    expect(doesNothing({ command: 'true' })).toBe(true)
    expect(doesNothing({ command: ':' })).toBe(true)
  })

  it('calls a chain of no-ops nothing too', () => {
    expect(doesNothing({ command: 'true; true' })).toBe(true)
    expect(doesNothing({ command: 'true && :' })).toBe(true)
    expect(doesNothing({ command: '  true  ' })).toBe(true)
  })

  it('ignores the arguments a no-op discards anyway', () => {
    expect(doesNothing({ command: 'true # idle while the build runs' })).toBe(true)
    expect(doesNothing({ command: ': still waiting' })).toBe(true)
  })

  it('leaves real commands alone, including words that merely start with one', () => {
    expect(doesNothing({ command: 'echo hi' })).toBe(false)
    expect(doesNothing({ command: 'bun test' })).toBe(false)
    expect(doesNothing({ command: 'cat truestory.txt' })).toBe(false)
    expect(doesNothing({ command: 'true; echo done' })).toBe(false)
  })

  it('has nothing to say about an empty command', () => {
    expect(doesNothing({ command: '' })).toBe(false)
    expect(doesNothing({ command: '# only a comment' })).toBe(false)
  })
})

describe('the waits the real event log recorded', () => {
  it('refuses every poll loop that burned a turn', () => {
    expect(waits('for i in $(seq 1 115); do [ -f /tmp/x.done ] && break; sleep 5; done')).toBe(true)
    expect(
      waits('for i in $(seq 1 60); do run=$(gh api repos/o/r/actions/runs); sleep 20; done'),
    ).toBe(true)
    expect(waits('while true; do gh pr checks 272; sleep 30; done')).toBe(true)
    expect(waits('sleep 60')).toBe(true)
    expect(waits('sleep 20; sleep 20; sleep 20')).toBe(true)
  })

  it('leaves the work that only looks like waiting alone', () => {
    expect(waits('sleep 5')).toBe(false)
    expect(waits('sleep 25')).toBe(false)
    expect(waits('for f in *.ts; do echo $f; done')).toBe(false)
    expect(waits('bun test')).toBe(false)
    expect(waits('grep -rn "sleep" src')).toBe(false)
  })
})
