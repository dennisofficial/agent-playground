import { describe, expect, it } from 'bun:test';
import { BackgroundHold, EHoldVerdict } from '../background-hold.js';
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
});
