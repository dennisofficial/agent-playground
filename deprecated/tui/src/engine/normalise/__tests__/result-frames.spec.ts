import { describe, expect, it } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { isWakeUpOnly } from '../result-frames.js';

/**
 * Which `result` frames end a turn.
 *
 * Every row below is a shape lifted off a real tape under `~/.atlas/sessions`, because the cost of
 * this predicate is asymmetric and invented fixtures would not have caught the mistake it did catch:
 * a false "terminal" ends one turn early, a false "non-terminal" holds a lane open with no timer
 * armed and nothing left to re-evaluate it.
 */

type Frame = Extract<SDKMessage, { type: 'result' }>;

function frame(overrides: Record<string, unknown>): Frame {
  return {
    type: 'result',
    subtype: 'success',
    session_id: 's',
    uuid: 'u',
    is_error: false,
    result: '',
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    ...overrides,
  } as unknown as Frame;
}

const TERMINAL: [string, Frame][] = [
  [
    'an ordinary completed turn',
    frame({ terminal_reason: 'completed', stop_reason: 'end_turn', num_turns: 9 }),
  ],
  [
    'a wake-up that woke the model and it WORKED — the success path of the whole hold feature',
    frame({
      terminal_reason: 'completed',
      stop_reason: 'end_turn',
      num_turns: 16,
      origin: { kind: 'task-notification' },
    }),
  ],
  [
    'the same, one turn long — 235 output tokens is still work',
    frame({
      terminal_reason: 'completed',
      stop_reason: 'end_turn',
      num_turns: 1,
      origin: { kind: 'task-notification' },
    }),
  ],
  [
    'an API error mid-turn',
    frame({
      is_error: true,
      terminal_reason: 'api_error',
      stop_reason: 'stop_sequence',
      num_turns: 12,
      result: 'API Error: Connection closed mid-response',
    }),
  ],
  // The local slash commands. Every one carries the same null/null/0 signature as the degenerate
  // wake-up and differs ONLY by having no origin — `TerminalReason` is documented "Unset when the
  // loop was bypassed (local slash command)". A predicate keying on those fields alone wedges the
  // lane on all five.
  ...(['## Context Usage', 'You are currently using your subscription', 'Unknown command: /thread', "/model isn't available in this environment", ''].map(
    (result): [string, Frame] => [
      `the local slash command answering ${JSON.stringify(result.slice(0, 24))}`,
      frame({ terminal_reason: null, stop_reason: null, num_turns: 0, result }),
    ],
  )),
];

const NON_TERMINAL: [string, Frame][] = [
  [
    'the orphan-tombstone wake-up: notification consumed, loop never entered, nothing produced',
    frame({
      terminal_reason: null,
      stop_reason: null,
      num_turns: 0,
      origin: { kind: 'task-notification' },
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
  ],
  [
    'the same shape delivered as an auto-continuation',
    frame({
      terminal_reason: null,
      stop_reason: null,
      num_turns: 0,
      origin: { kind: 'auto-continuation' },
    }),
  ],
  [
    'a wake-up whose terminal_reason is absent rather than null',
    frame({ stop_reason: null, num_turns: 0, origin: { kind: 'task-notification' } }),
  ],
];

describe('isWakeUpOnly', () => {
  for (const [name, message] of TERMINAL) {
    it(`ends the turn on ${name}`, () => {
      expect(isWakeUpOnly(message)).toBe(false);
    });
  }

  for (const [name, message] of NON_TERMINAL) {
    it(`does not end the turn on ${name}`, () => {
      expect(isWakeUpOnly(message)).toBe(true);
    });
  }

  it('refuses an errored frame however it was delivered — an error is always an ending', () => {
    expect(
      isWakeUpOnly(
        frame({
          is_error: true,
          terminal_reason: null,
          stop_reason: null,
          num_turns: 0,
          origin: { kind: 'task-notification' },
        }),
      ),
    ).toBe(false);
  });

  it('refuses an origin it does not recognise, rather than guessing', () => {
    for (const kind of ['human', 'peer', 'channel', 'coordinator', 'observer']) {
      expect(
        isWakeUpOnly(
          frame({ terminal_reason: null, stop_reason: null, num_turns: 0, origin: { kind } }),
        ),
      ).toBe(false);
    }
  });
});
