import { describe, expect, it } from 'bun:test';
import { CANARY, ECanaryHealth } from '../../domain/canary.js';
import { EContextSignal } from '../../domain/context-nudge.js';
import type { EngineEvent } from '../../domain/message.js';
import { EMessageType } from '../../generated/prisma/enums.js';
import type { Thread } from '../../generated/prisma/client.js';
import { SESSION, THREAD, build } from './turn-runner.fixture.js';

/**
 * The budget and the canary, end to end through a real turn: what the model is handed, what the
 * transcript keeps, and what Dennis sees — for the same reading, in the two roles that answer the
 * "who acts next" question differently.
 *
 * `SESSION` is `claude-opus-5`, so the budget is 300K soft / 420K hard.
 */

/** A conversational thread: here the CONVERSATION is the artifact, so the human is told, not the agent. */
const CHARTING = { ...THREAD, id: 'thread-charting', role: 'charting' } as unknown as Thread;

const toolResult = (): EngineEvent => ({
  kind: 'tool_result',
  toolUseId: 'tool-1',
  ok: true,
  summary: 'read 40 lines',
  detail: [],
});

const usage = (contextTokens: number): EngineEvent => ({
  kind: 'usage',
  contextTokens,
  contextLimit: 1_000_000,
});

describe('the nudge', () => {
  it('says nothing at all while the session is inside its budget', async () => {
    // 190K used to be a nudge and is now silence: the Opus row was raised to 300K because asking for
    // a hand-off at 18% of a million-token window fired several times a working session.
    const { runner, engine, messages } = build([usage(190_000), toolResult()]);
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

    expect(engine.toolBoundaries).toEqual([undefined]);
    expect(messages.appended.some((m) => m.payload.type === EMessageType.harness)).toBe(false);
  });

  it('ADVISES the agent at the soft threshold, leaving it to pick the seam', async () => {
    const { runner, engine } = build([usage(310_000), toolResult()]);
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

    const [nudge] = engine.toolBoundaries;
    // The reason, then advice — an agent told to stop dead the moment it crosses abandons whatever it
    // was holding, and a hand-off written from a half-applied edit is worse than the tokens it saved.
    expect(nudge).toContain('This session is at 310K of a 300K budget.');
    expect(nudge).toContain('Finish what you are in the middle of');
    expect(nudge).not.toContain('Call `rotate` now');
    // Enveloped, because it arrives on the harness channel: untagged it would read as Dennis asking.
    expect(nudge).toContain('<harness variant="transition">');
  });

  it('turns insistent only past the HARD threshold, where the advice has stopped working', async () => {
    // 430K on a 300K/420K budget: 120K of runway after the advisory, ~6 escalating asks, and the seam
    // the agent was invited to choose has come and gone. Still a request — nothing here cuts.
    const { runner, engine } = build([usage(430_000), toolResult()]);
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

    const [nudge] = engine.toolBoundaries;
    expect(nudge).toContain('Call `rotate` now');
    expect(nudge).toContain('re-sends the whole transcript');
  });

  it('persists the nudge, so the transcript shows what Atlas put in the conversation', async () => {
    // Atlas is transparent about what it does to a conversation: the injection is a real message,
    // written next to the tool result that carried it, and what the agent did next is an answer to it.
    const { runner, messages } = build([usage(310_000), toolResult()]);
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

    const harness = messages.appended.filter((m) => m.payload.type === EMessageType.harness);
    expect(harness).toHaveLength(1);
    expect(harness[0]?.payload).toMatchObject({ variant: 'transition' });
  });

  /**
   * The conversational roles are told NOTHING, on either channel. Not the agent — volunteering a
   * hand-off mid-sentence is the interruption the audience rule exists to prevent — and not the
   * transcript either, because the human's channel is the `ctx` meter, which carries the same fact
   * continuously instead of pushing a row in at every crossing.
   */
  it('says nothing at all where the human is the one having the conversation', async () => {
    const { runner, engine, stores, messages } = build([usage(310_000), toolResult()]);
    await runner.run({ thread: CHARTING, session: SESSION, prompt: 'go', cwd: '/repo' });

    expect(engine.toolBoundaries).toEqual([undefined]);
    expect(messages.appended.some((m) => m.payload.type === EMessageType.harness)).toBe(false);
    expect(stores.for(CHARTING.id).getSnapshot().notices).toEqual([]);
    // The meter is where it went: same crossing, a reading rather than a row.
    expect(stores.for(CHARTING.id).getSnapshot().contextReading?.tokens).toBe(310_000);
  });

  it('never nudges twice in one turn, however many tools the agent calls', async () => {
    const { runner, engine } = build([
      usage(310_000),
      toolResult(),
      usage(316_000),
      toolResult(),
      usage(323_000),
      toolResult(),
    ]);
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

    expect(engine.toolBoundaries.filter((text) => text !== undefined)).toHaveLength(1);
  });

  it('does not cut: the turn finishes normally and the session is untouched', async () => {
    // The most a nudge can do is put a sentence in front of the agent. Ignoring it is the only
    // suppression there is, and it is deliberately the one that costs nothing to use.
    const { runner, sessionManager, sessions } = build([usage(500_000), toolResult()]);
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

    expect(sessionManager.rotateSession).not.toHaveBeenCalled();
    expect(sessions.recordContextUsage).toHaveBeenCalledWith('session-1', {
      contextTokens: 500_000,
      contextLimit: 1_000_000,
    });
  });
});

describe('the canary', () => {
  const spoke = (text: string): EngineEvent => ({ kind: 'text', text });

  it('is read off the STORED text, never the rendered text', async () => {
    const { runner, messages, pressure } = build([spoke(`${CANARY} on it.`)]);
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

    // The glyph survives into the store untouched — stripping on the way in would delete the very
    // signal being measured, and every prose surface strips it again at render.
    expect(messages.appended.at(-1)?.payload).toMatchObject({
      type: EMessageType.assistant,
      text: `${CANARY} on it.`,
    });
    expect(pressure.health('session-1')).toBe(ECanaryHealth.unknown);
  });

  /**
   * A dead canary is a READING, not an announcement. It used to also write a row into the
   * transcript; the meter's signal is the whole of it now — see the test below, which is the one
   * that proves the measurement still works.
   */
  it('says nothing in the transcript when it dies', async () => {
    const { runner, store, pressure } = build([spoke('no glyph here')]);
    for (let turn = 0; turn < 4; turn += 1) {
      await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });
    }

    expect(store.getSnapshot().notices).toEqual([]);
    expect(pressure.health('session-1')).toBe(ECanaryHealth.dead);
  });

  it('takes the ctx label once it is dead, because it is a different situation', async () => {
    // Four turns: the third is where it dies, and the reading taken on the fourth is the first one
    // drawn with that verdict in hand.
    const { runner, store } = build([spoke('no glyph here'), usage(60_000)]);
    for (let turn = 0; turn < 4; turn += 1) {
      await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });
    }

    const reading = store.getSnapshot().contextReading;
    // 6% of the window — cheap and confused, which is precisely the state a gauge alone cannot see.
    expect(reading?.percent).toBe(6);
    expect(reading?.signal).toBe(EContextSignal.canary);
  });
});
