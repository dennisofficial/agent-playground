import { describe, expect, it } from 'bun:test';
import {
  contextWallStub,
  isContextWall,
  renderRotationHandoff,
  rotationRequest,
} from '../rotation-handoff.js';

const SECTIONS = {
  done: 'Slice 3 landed; `bun test` is green.',
  triedAndRejected: 'A shared cache — invalidation is per-job, so it never paid for itself.',
  surprises: 'The fetch wrapper adds an auth header and it breaks the signature.',
  next: 'Wire slice 4’s upload route.',
};

describe('renderRotationHandoff', () => {
  it('keeps the four sections apart and named — the schema is the rail, so the render is too', () => {
    const text = renderRotationHandoff({ sections: SECTIONS });

    expect(text).toContain('## Done');
    expect(text).toContain('## Tried and rejected');
    expect(text).toContain('## Surprises');
    expect(text).toContain('## Next');
    expect(text).toContain('invalidation is per-job');
  });

  it('carries the agent’s words through verbatim — Atlas never summarises a hand-off', () => {
    const text = renderRotationHandoff({ sections: SECTIONS });

    for (const section of Object.values(SECTIONS)) expect(text).toContain(section);
  });

  /**
   * Tasks outlive the session, so leg 2 inherits ids it has never seen — `#3` is meaningless to it
   * unless the list crosses the seam with the report.
   */
  it('appends the rendered task list when one is handed in, and nothing when it is empty', () => {
    const tasks = '#1 [completed] Write the route\n#2 [in_progress] Wire the composer';

    expect(renderRotationHandoff({ sections: SECTIONS, tasks })).toContain('#2 [in_progress]');
    expect(renderRotationHandoff({ sections: SECTIONS, tasks: '' })).toBe(
      renderRotationHandoff({ sections: SECTIONS }),
    );
  });

  it('omits Notes entirely when there were none, rather than printing an empty heading', () => {
    expect(renderRotationHandoff({ sections: SECTIONS })).not.toContain('## Notes');
    expect(renderRotationHandoff({ sections: { ...SECTIONS, notes: '   ' } })).not.toContain('## Notes');
    expect(renderRotationHandoff({ sections: { ...SECTIONS, notes: 'the CI box is slow' } })).toContain(
      '## Notes',
    );
  });
});

describe('rotationRequest', () => {
  it('asks for the tool call rather than announcing a cut — the manual and nudged paths are one', () => {
    const text = rotationRequest();

    expect(text).toContain('`rotate`');
    expect(text).toContain('tried and rejected');
  });

  it('leads with the reason it was sent, so a nudge can say what tripped it', () => {
    expect(rotationRequest({ reason: 'This session is 92% of its budget.' })).toStartWith(
      'This session is 92% of its budget.',
    );
  });
});

describe('contextWallStub', () => {
  /**
   * The stub is the ONE hand-off Atlas writes itself, and it deliberately writes as little as
   * possible: a host summary of a session that ran out of room is lossy exactly where it matters.
   */
  it('sends the successor to the transcript instead of handing it a host summary', () => {
    const text = contextWallStub({ threadId: 'thread-1', ordinal: 2 });

    expect(text).toContain('atlas transcript thread-1 --full');
    expect(text).toContain('leg 2');
    expect(text).toContain('did not summarise');
  });
});

describe('isContextWall', () => {
  const walls = [
    'prompt is too long: 213043 tokens > 200000 maximum',
    'input length and `max_tokens` exceed context limit: 190000 + 32000 > 200000',
    'context_length_exceeded',
    "This model's maximum context length is 200000 tokens",
  ];

  it.each(walls)('recognises the wall: %s', (detail) => {
    expect(isContextWall({ title: 'API Error: 400', detail })).toBe(true);
  });

  /**
   * The other half of the claim, and the more important one: an engine crash must NOT rotate. The
   * transcript is intact and resuming costs nothing, so burning a leg on it throws away a working
   * context for free.
   */
  const survivors = [
    'claude agent sdk exited · Thread preserved · r to restart',
    'API Error: 529 overloaded_error',
    'rate limit reached for this account · 5-hour window',
    'spawn ENOENT',
  ];

  it.each(survivors)('leaves an ordinary failure alone: %s', (detail) => {
    expect(isContextWall({ title: 'Engine error', detail })).toBe(false);
  });

  it('reads the title as well as the detail — some engines put it all in one line', () => {
    expect(isContextWall({ title: 'prompt is too long' })).toBe(true);
  });
});
