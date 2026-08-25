import { describe, expect, it } from 'bun:test';
import {
  BackgroundHold,
  EHoldVerdict,
  SHELL_HOLD_CAP_MS,
  SHELL_HOLD_CAP_STEER,
} from '../background-hold.js';
import { EDelegateStatus, type EngineEvent } from '../../domain/message.js';

/**
 * The rule that decides whether `result` really ends a turn.
 *
 * Getting this wrong is silent in both directions: end too early and a backgrounded agent dies with
 * the CLI process (the bug — Atlas's own tapes carry the "no completion record was found" epitaph),
 * hold too long and a `tail -f` pins a thread open forever.
 */

function agentStarted(taskId: string): EngineEvent {
  return {
    kind: 'task_started',
    taskId,
    description: 'Explore the codebase',
    agentType: 'Explore',
    taskType: 'local_agent',
    background: false,
  };
}

function shellStarted(taskId: string): EngineEvent {
  return {
    kind: 'task_started',
    taskId,
    description: 'pnpm test',
    taskType: 'local_bash',
    background: false,
  };
}

function settled(taskId: string): EngineEvent {
  return { kind: 'task_settled', taskId, status: EDelegateStatus.completed };
}

describe('BackgroundHold', () => {
  it('ends the turn when nothing was spawned — the overwhelming common case', () => {
    expect(new BackgroundHold().verdict()).toBe(EHoldVerdict.end);
  });

  it('holds with no deadline for a live agent, which may legitimately run for an hour', () => {
    const hold = new BackgroundHold();
    hold.observe(agentStarted('t1'));
    expect(hold.verdict()).toBe(EHoldVerdict.hold);
  });

  it('holds a bare shell under a cap, because a `tail -f` never settles', () => {
    const hold = new BackgroundHold();
    hold.observe(shellStarted('t1'));
    expect(hold.verdict()).toBe(EHoldVerdict.holdCapped);
  });

  it('suspends the cap entirely while an agent is among the held work', () => {
    const hold = new BackgroundHold();
    hold.observe(shellStarted('t1'));
    hold.observe(agentStarted('t2'));
    expect(hold.verdict()).toBe(EHoldVerdict.hold);
    // The agent settling drops it back to the capped hold rather than ending the turn: the shell is
    // still live and still the reason this session is open.
    hold.observe(settled('t2'));
    expect(hold.verdict()).toBe(EHoldVerdict.holdCapped);
  });

  it('ends once the last held thing settles', () => {
    const hold = new BackgroundHold();
    hold.observe(agentStarted('t1'));
    hold.observe(settled('t1'));
    expect(hold.verdict()).toBe(EHoldVerdict.end);
  });

  it('ends at the next result once capped, whatever is still live', () => {
    const hold = new BackgroundHold();
    hold.observe(shellStarted('t1'));
    hold.markCapped();
    // The model has been told and has answered. Holding a second time would make the cap advisory in
    // name only, and the thread would never rotate.
    expect(hold.verdict()).toBe(EHoldVerdict.end);
  });

  it('learns about work it never saw start, from the membership level', () => {
    const hold = new BackgroundHold();
    hold.observe({
      kind: 'background_tasks',
      tasks: [{ taskId: 't9', taskType: 'local_agent', description: 'inherited' }],
    });
    expect(hold.verdict()).toBe(EHoldVerdict.hold);
  });

  it('never lets the level retire anything — a foreground agent never appears in it', () => {
    const hold = new BackgroundHold();
    hold.observe(agentStarted('t1'));
    hold.observe({ kind: 'background_tasks', tasks: [] });
    expect(hold.verdict()).toBe(EHoldVerdict.hold);
  });

  /**
   * The one case where an empty live set does NOT mean the turn is over: the CLI's orphan-recovery
   * path delivers a run of tombstones, which settle everything, and answers with a `result` that did
   * no work at all. Ending there books a turn that never started — three of the ten `Turn` rows in
   * `~/.atlas/atlas.db` are exactly that.
   */
  it('holds briefly on a bare wake-up with nothing live, rather than ending a turn that never ran', () => {
    const hold = new BackgroundHold();
    expect(hold.verdict({ nonTerminal: true })).toBe(EHoldVerdict.holdBriefly);
  });

  it('prefers live work to the hint — a wake-up while an agent runs is an ordinary hold', () => {
    const hold = new BackgroundHold();
    hold.observe(agentStarted('t1'));
    expect(hold.verdict({ nonTerminal: true })).toBe(EHoldVerdict.hold);

    const shells = new BackgroundHold();
    shells.observe(shellStarted('t2'));
    expect(shells.verdict({ nonTerminal: true })).toBe(EHoldVerdict.holdCapped);
  });

  it('still ends once capped, so the hint cannot reopen a hold the model was already told about', () => {
    const hold = new BackgroundHold();
    hold.markCapped();
    expect(hold.verdict({ nonTerminal: true })).toBe(EHoldVerdict.end);
  });

  it('defaults to ending — every shape nobody enumerated is a turn end', () => {
    expect(new BackgroundHold().verdict({ nonTerminal: false })).toBe(EHoldVerdict.end);
    expect(new BackgroundHold().verdict()).toBe(EHoldVerdict.end);
  });
});

describe('the shell cap', () => {
  /**
   * `Monitor`'s own documented maximum `timeout_ms`. The cap is set FROM this rather than from taste:
   * anything shorter steers work the tool itself says is legitimate, and the corpus's 17 real
   * `Monitor` calls run from 45 s to 45 min — a ten-minute cap, which is what this was, would have
   * steered a 45-minute CI poll at minute 10 and ended the turn at the model's next stop. Killing
   * that poll is the exact failure the hold exists to prevent, arriving by a different door.
   */
  const MONITOR_MAX_TIMEOUT_MS = 3_600_000;

  it('is no shorter than the longest run the tools themselves permit', () => {
    expect(SHELL_HOLD_CAP_MS).toBeGreaterThanOrEqual(MONITOR_MAX_TIMEOUT_MS);
  });

  it('tells the model the same number it actually enforces', () => {
    // Prose and constant drifting apart is silent and misleads the one reader who cannot check.
    expect(SHELL_HOLD_CAP_MS).toBe(60 * 60 * 1000);
    expect(SHELL_HOLD_CAP_STEER).toContain('over an hour');
    // The cap fires exactly when a long-lived process has been put on the wrong tool, so this is
    // the one place the model is told there is a right one. Named in slice 04's spec as the single
    // ordering constraint between the hold and the service facility.
    expect(SHELL_HOLD_CAP_STEER).toContain('service_start');
  });
});
