import { parseColor, type CapturedFrame } from '@opentui/core';
import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import React from 'react';
import { EAttentionCourt } from '../../domain/attention.js';
import type { HeaderFacts } from '../../domain/conversation-header.js';
import { ConversationHeader } from '../components/conversation-header.js';
import { theme } from '../theme.js';

/**
 * The header, drawn for real and read back off the frame.
 *
 * Asserted here rather than in `domain/` for the reason `user-block.spec` gives: what is under test
 * IS the pixels. Which of three tiers a word is drawn in does not survive as a string, and the whole
 * argument for the redesign was that the old header drew all three the same.
 */

const WIDTH = 100;

const facts = (over: Partial<HeaderFacts> = {}): HeaderFacts => ({
  jobTitle: 'redesign the conversation header',
  repo: 'atlas',
  role: 'implementer',
  siblings: 0,
  closed: false,
  status: { label: 'reply', court: EAttentionCourt.yours, spinner: false },
  git: { cwdLabel: null, checkoutBranch: 'main' },
  ...over,
});

async function draw(
  over: Partial<HeaderFacts> = {},
  elapsedMs: number | null = null,
): Promise<{ frame: CapturedFrame; rows: string[]; destroy: () => void }> {
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={5}>
      <ConversationHeader
        facts={facts(over)}
        width={WIDTH}
        elapsedMs={elapsedMs}
        frame="⠹"
      />
    </box>,
    { width: WIDTH, height: 5 },
  );
  await setup.flush();
  return {
    frame: setup.captureSpans(),
    rows: setup.captureCharFrame().split('\n'),
    destroy: () => setup.renderer.destroy(),
  };
}

/** Every span drawn in a given colour, anywhere in the frame. */
function textIn(frame: CapturedFrame, colour: string): string {
  const wanted = parseColor(colour);
  return frame.lines
    .flatMap((line) => line.spans.filter((span) => span.fg.equals(wanted)))
    .map((span) => span.text)
    .join('');
}

describe('the three rows', () => {
  it('puts the job title on the first and the place on the second', async () => {
    const { rows, destroy } = await draw();
    expect(rows[0]).toContain('redesign the conversation header');
    expect(rows[1]).toContain('atlas');
    expect(rows[1]).toContain('main');
    destroy();
  });

  it('closes with a rule the full width of the terminal', async () => {
    // Not a blank row. The old header spent one anyway just to keep off the transcript; the rule
    // costs the same and is what makes two rows read as one region.
    const { rows, destroy } = await draw();
    expect(rows[2]?.trimEnd()).toBe('─'.repeat(WIDTH));
    destroy();
  });

  it('right-aligns the status against the title', async () => {
    const { rows, destroy } = await draw();
    expect(rows[0]?.trimEnd().endsWith('reply')).toBe(true);
    destroy();
  });
});

describe('three tiers of text, which is the whole point', () => {
  it('draws the title brighter than the metadata beneath it', async () => {
    // The failure being fixed: one flat grey run in which the job title — the only string that tells
    // six tiles apart — weighed exactly the same as the model id.
    const { frame, destroy } = await draw();
    expect(textIn(frame, theme.hover)).toContain('redesign the conversation header');
    expect(textIn(frame, theme.meta)).toContain('main');
    expect(textIn(frame, theme.hover)).not.toContain('main');
    destroy();
  });

  it('keeps the rule and the separators below the metadata', async () => {
    const { frame, destroy } = await draw({ siblings: 2 });
    const rule = textIn(frame, theme.rule);
    expect(rule).toContain('─');
    expect(rule).toContain('·');
    destroy();
  });
});

describe('what is happening', () => {
  it('shows the spinner frame and the clock while a turn runs', async () => {
    const { rows, destroy } = await draw(
      { status: { label: 'working…', court: EAttentionCourt.agent, spinner: true } },
      72_000,
    );
    expect(rows[0]?.startsWith('⠹ ')).toBe(true);
    expect(rows[0]).toContain('working… 1m 12s');
    destroy();
  });

  it('leads with ❯ when the ball is in your court', async () => {
    const { rows, destroy } = await draw();
    expect(rows[0]?.startsWith('❯ ')).toBe(true);
    destroy();
  });

  it('says a closed thread is closed, in the warning colour, without a court', async () => {
    const { frame, rows, destroy } = await draw({ closed: true });
    expect(textIn(frame, theme.warn)).toContain('closed');
    // The glyph cell is the dim dot, not the word — folding the two together once printed
    // `closedmake the top bar…` straight into the title.
    expect(rows[0]?.startsWith('· ')).toBe(true);
    destroy();
  });
});

describe('where the agent is standing', () => {
  it('names the branch it will commit onto when it works in your tree', async () => {
    const { rows, destroy } = await draw();
    expect(rows[1]).toContain('⌂ main');
    destroy();
  });

  it('marks a directory that is not the repository root', async () => {
    const { rows, destroy } = await draw({
      git: {
        cwdLabel: '.worktrees/fix-a1b2c3d4',
        checkoutBranch: 'atlas/fix-a1b2c3d4',
      },
    });
    // The path repeats the branch here, so only the branch is drawn — see `headerPlace`.
    expect(rows[1]).toContain('⑂ atlas/fix-a1b2c3d4');
    expect(rows[1]).not.toContain('.worktrees');
    destroy();
  });
});

describe('siblings', () => {
  it('says nothing when this is the only live thread', async () => {
    const { rows, destroy } = await draw();
    expect(rows[1]).not.toContain('+');
    destroy();
  });

  it('counts other live threads of this job, in the working colour', async () => {
    const { frame, destroy } = await draw({ siblings: 2 });
    expect(textIn(frame, theme.court.agent)).toContain('+2 threads');
    destroy();
  });
});

describe('narrow terminals', () => {
  it('clips the title rather than wrapping it', async () => {
    // A header that wraps is a header that moves the transcript under the reader.
    const setup = await testRender(
      <box flexDirection="column" width={40} height={5}>
        <ConversationHeader
          facts={facts({ jobTitle: 'a title far longer than forty columns of terminal' })}
          width={40}
          elapsedMs={null}
          frame="⠹"
        />
      </box>,
      { width: 40, height: 5 },
    );
    await setup.flush();
    const rows = setup.captureCharFrame().split('\n');
    expect(rows[0]).toContain('…');
    expect(rows[2]?.trimEnd()).toBe('─'.repeat(40));
    setup.renderer.destroy();
  });
});
